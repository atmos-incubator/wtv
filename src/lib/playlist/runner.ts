/**
 * Background playlist runner. One running playlist per tab; state in storage.session so
 * it survives service-worker restarts. Every operation runs through one queue, so
 * overlapping events (an `ended` and a navigation, say) can't both advance.
 *
 * Moving to an entry: blackout the current page, bump `gen`, navigate the tab to the
 * entry URL plus a `#wtv:` hash (start time + title: see hash.ts). The new page's frames
 * say hello; the runner answers with the entry (title, ad program) if the
 * page is that entry. The top frame keeps its blackout up until something plays.
 *
 * End of an entry, whichever comes first:
 *   - a frame reports `ended` (the `ended` event, or playback reaching the last 0.25 s);
 *   - the tab navigates off the entry after a frame reported `near-end` (last 20 s:
 *     YouTube autoplay / end screens can pre-empt `ended`).
 * Navigating off the entry *before* near-end is the user doing something else: the
 * runner detaches and waits for Resume instead of hijacking the tab.
 *
 * An entry with an end time (`end=` / `dur=`) reports `ended` when the media reaches it.
 *
 * Gone: a frame that sees the site's `unavailable` role reports `gone`. The entry is
 * marked gone in the media library, the tab shows "Unavailable: <title>" for 3 s (in TV
 * mode or kept maximized: no notice, the next entry straight away), and
 * the runner moves on.
 *
 * Media library (media-library/): `playing` records the play (status ok, last played);
 * frames report what they learn about the entry (PL_INFO: title, creator, duration,
 * thumbnail), always filed under the runner's own entry URL, never one a page names.
 *
 * Order (order.ts): entries play in `order`, which is shuffled once at start when
 * shuffling, so Previous retraces it. Looping: past the last entry, a new lap starts
 * (reshuffled when shuffling); otherwise the run finishes.
 *
 * Pages and posts (`view=read` / `scroll` / `card`): a read / scroll entry is its own
 * page, shown by the content script there (page-show/), which reports `ended` when it's
 * done; the hash says so (`v=`), so the page doesn't wait for a video. A card entry
 * plays on the extension's card page, which says hello like a page, asks for the post
 * (PL_POST), and reports `ended` when its time is up. Where the post comes from
 * (posts/source.ts), decided as the entry starts:
 *   - `page`: the site has post selectors (and Wtv has access to it). The tab goes to
 *     the post's own page first (`v=card`, behind the blackout), whose content script
 *     reads the post with them and sends it (PL_PAGE_POST); then on to the card page.
 *     A post with an embedded player (the `postEmbed` role) stays on its page instead:
 *     the content script frames the card page over it and lifts the player into a slot
 *     beside the post (posts/embed.ts); the framed card page talks to the runner as usual.
 *     The page is the user's own session, so it works signed in. Its address may change
 *     while it's read (SPAs tidy their URLs); that doesn't count as leaving.
 *   - `api`: straight to the card page; the post is fetched here through the site's
 *     adapter (posts/), anonymously. Also the fallback when reading the page failed.
 *
 * The playlist is snapshotted when it starts; edits apply the next time it's played.
 * Starting one also records when it last played, for the explorer's order (explore.ts).
 */
import { browser } from 'wxt/browser';
import { browserAreas } from '../browser-storage';
import { isWebUrl } from '../permissions';
import { KEYS } from '../storage';
import { setTvMode, watchingFullView } from '../view/controller';
import { compilePlaylist, isPageView, parsePlaylist, type ViewMode } from './format';
import { withWtvHash } from './hash';
import { sameEntryUrl } from './match';
import { nextLap, reshuffle, startOrder, validOrder } from './order';
import {
  PL_APPLY,
  PL_COMMAND,
  PL_HELLO,
  PL_INFO,
  PL_MEDIA,
  PL_PAGE_POST,
  PL_POST,
  PL_RUNS,
  PL_STATE,
  parsePlaylistRequest,
  type EntryInfo,
  type MediaEvent,
  type MediaInfo,
  type PlaylistApply,
  type PostResult,
  type RunnerSummary,
  type RunSummary,
  type StepOp,
} from './messages';
import { parsePlays, withPlay } from './explore';
import { getBuiltinPlaylist } from './builtin-bundle';
import { getPlaylist } from './store';
import { getRecord } from '../media-library/db';
import { libraryKey } from '../media-library/record';
import { updateMedia } from '../media-library/service';
import { cardDurationS, findPostAdapter, postTitle } from '../posts/adapters';
import { fetchPost } from '../posts/fetch';
import { embedCardDurationS } from '../posts/embed-layout';
import { cardSource, type CardSource } from '../posts/source';
import { originPatternsFor } from './match';
import { BUNDLED_SITES } from '../sites/bundled';
import { loadOverrideStore } from '../sites/override-store';
import type { ProgramItem } from '../overlay/program';

interface RunEntry {
  url: string;
  title: string | null;
  startS: number | null;
  /** Missing in runs started before end times existed. */
  endS?: number | null;
  ads: ProgramItem[] | null;
  /** Missing in runs started before views existed: video. */
  view?: ViewMode;
  show?: ProgramItem[] | null;
  /** Missing in runs started before page views: the default. */
  speed?: number | null;
}

export interface RunnerState {
  playlistId: string;
  name: string;
  /** In playlist order. */
  entries: RunEntry[];
  /** Entry indexes in play order (missing in runs started before shuffle: in order). */
  order?: number[];
  /** Position in the play order. */
  index: number;
  shuffle?: boolean;
  loop?: boolean;
  /** Laps started so far, from 1. */
  lap?: number;
  gen: number;
  /** navigating: waiting for the entry's page. playing: on it. detached: user went elsewhere. */
  phase: 'navigating' | 'playing' | 'detached';
  /** The entry's URL as the tab actually shows it (after redirects). */
  currentUrl: string | null;
  nearEnd: boolean;
  /** A `view=card` entry (this gen): where its post comes from, and what its page said. */
  card?: { source: CardSource; result: PostResult | null; inPage?: boolean } | null;
}

type RunnerStore = Record<string, RunnerState>;

export const PLAYLIST_COMMANDS = { next: 'next', previous: 'previous' } as const;

/** How long "Unavailable: <title>" shows before the next entry. */
const GONE_DWELL_MS = 3000;

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task);
  queue = next.catch((err: unknown) => console.error('[wtv] playlist runner:', err));
  return next;
}

async function load(): Promise<RunnerStore> {
  const raw = (await browser.storage.session.get(KEYS.runner))[KEYS.runner];
  return typeof raw === 'object' && raw !== null ? (raw as RunnerStore) : {};
}

async function put(tabId: number, state: RunnerState | null): Promise<void> {
  const store = await load();
  if (state) store[tabId] = state;
  else delete store[tabId];
  await browser.storage.session.set({ [KEYS.runner]: store });
}

/** The play order (validated) and the entry at `position` in it. */
function playOrder(state: RunnerState): number[] {
  return validOrder(state.order, state.entries.length);
}

function entryAt(state: RunnerState, position = state.index): RunEntry | undefined {
  const i = playOrder(state)[position];
  return i === undefined ? undefined : state.entries[i];
}

function displayTitle(entry: RunEntry): string {
  if (entry.title) return entry.title;
  try {
    return new URL(entry.url).hostname;
  } catch {
    return entry.url;
  }
}

async function toTop(tabId: number, msg: PlaylistApply): Promise<void> {
  await browser.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => undefined);
}

function withoutHash(url: string): string {
  return url.split('#')[0] ?? url;
}

async function goTo(tabId: number, state: RunnerState, index: number): Promise<void> {
  let from = state;
  let position = index;
  if (position >= state.entries.length) {
    if (!state.loop) {
      console.info(`[wtv] playlist "${state.name}" finished in tab ${tabId}`);
      await put(tabId, null);
      await toTop(tabId, { type: PL_APPLY, op: 'release' });
      return;
    }
    const lap = (state.lap ?? 1) + 1;
    console.info(`[wtv] playlist "${state.name}" looping in tab ${tabId}: lap ${lap}`);
    from = { ...state, order: nextLap(playOrder(state), state.shuffle ?? false), lap };
    position = 0;
  }
  position = Math.max(0, position);
  const next: RunnerState = {
    ...from,
    index: position,
    gen: state.gen + 1,
    phase: 'navigating',
    currentUrl: null,
    nearEnd: false,
    card: null,
  };
  const entry = entryAt(next)!;
  if (entry.view === 'card') next.card = { source: await postSource(entry.url), result: null };
  await put(tabId, next);
  // Go dark on the page we're leaving, so its end screen / autoplay never shows.
  // `gen`: a new move, so a new loading picture (not the one the page was still showing).
  await toTop(tabId, { type: PL_APPLY, op: 'blackout', title: displayTitle(entry), notice: false, gen: next.gen });
  await browser.tabs.update(tabId, { url: entryPageUrl(entry, next.gen, next.card?.source ?? null) });
}

/** A card entry: its page when the site has post selectors and Wtv may run there, else the API. */
async function postSource(url: string): Promise<CardSource> {
  const overrides = await loadOverrideStore(browserAreas().local).catch(() => ({}));
  if (cardSource(url, BUNDLED_SITES, overrides) !== 'page') return 'api';
  const origins = originPatternsFor([url]);
  const allowed = origins.length > 0 && (await browser.permissions.contains({ origins }).catch(() => false));
  return allowed ? 'page' : 'api';
}

/**
 * Where the tab goes for an entry. Posts from the API: the card page (`gen` makes each
 * visit a new page). Otherwise the entry itself, with a #wtv: hash that lets the new page
 * black out (and know its start / end time, or that it's a page show, or a post to read)
 * before it paints, without waiting for the hello round trip.
 */
function entryPageUrl(entry: RunEntry, gen: number, source: CardSource | null): string {
  if (entry.view === 'card' && source !== 'page') return cardPageUrl(gen);
  const view = entry.view && (isPageView(entry.view) || entry.view === 'card') ? entry.view : null;
  return withWtvHash(entry.url, { t: entry.startS, end: entry.endS ?? null, title: entry.title, view, gen });
}

const cardPageUrl = (gen: number) => browser.runtime.getURL(`/card.html?gen=${gen}`);

function sameHost(a: string, b: string | undefined): boolean {
  try {
    return b !== undefined && new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

async function start(
  playlistId: string,
  from: number | null,
  options: { tv: boolean; shuffle: boolean; loop: boolean },
): Promise<void> {
  const playlist = getBuiltinPlaylist(playlistId) ?? (await getPlaylist(browserAreas().local, playlistId));
  if (!playlist) throw new Error(`no playlist ${playlistId}`);
  const { entries } = compilePlaylist(parsePlaylist(playlist.text));
  if (entries.length === 0) throw new Error(`playlist "${playlist.name}" has no entries`);

  // Open the tab first and save the state before navigating, so the first page's hello
  // finds it.
  const tab = await browser.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined) throw new Error('could not open a tab');
  const { order, index } = startOrder(entries.length, from, options.shuffle);
  const state: RunnerState = {
    playlistId,
    name: playlist.name,
    entries: entries.map(({ url, title, startS, endS, ads, view, show, speed }) => ({
      url,
      title,
      startS,
      endS,
      ads,
      view,
      show,
      speed,
    })),
    order,
    index,
    shuffle: options.shuffle,
    loop: options.loop,
    lap: 1,
    gen: 0,
    phase: 'navigating',
    currentUrl: null,
    nearEnd: false,
  };
  await put(tab.id, state);
  await recordPlay(playlistId).catch((err: unknown) => console.warn('[wtv] could not record the play:', err));
  if (options.tv) await setTvMode(tab.id, true);
  await goTo(tab.id, state, index);
}

async function recordPlay(playlistId: string): Promise<void> {
  const local = browserAreas().local;
  const plays = parsePlays((await local.get(KEYS.playlistPlays))[KEYS.playlistPlays]);
  await local.set({ [KEYS.playlistPlays]: withPlay(plays, playlistId, Date.now()) });
}

async function step(tabId: number, op: StepOp): Promise<void> {
  const state = (await load())[tabId];
  if (!state) return;
  switch (op) {
    case 'next':
      return goTo(tabId, state, state.index + 1);
    case 'previous':
      return goTo(tabId, state, state.index - 1);
    case 'resume':
      return goTo(tabId, state, state.index);
    case 'reshuffle': {
      // The current entry keeps playing; what comes after it is new.
      if (!state.shuffle) return;
      const play = reshuffle({ order: playOrder(state), index: state.index });
      await put(tabId, { ...state, ...play });
      return;
    }
    case 'stop':
      await put(tabId, null);
      await toTop(tabId, { type: PL_APPLY, op: 'release' });
      return;
  }
}

function onEntry(state: RunnerState, url: string): boolean {
  const entry = entryAt(state);
  if (!entry) return false;
  return sameEntryUrl(url, entry.url) || (state.currentUrl !== null && sameEntryUrl(url, state.currentUrl));
}

async function hello(tabId: number, frameId: number, url: string): Promise<EntryInfo | null> {
  const state = (await load())[tabId];
  if (!state || state.phase === 'detached') return null;
  const entry = entryAt(state);
  if (!entry) return null;

  if (frameId === 0) {
    if (state.phase === 'navigating') {
      await put(tabId, { ...state, phase: 'playing', currentUrl: withoutHash(url) });
    } else if (!onEntry(state, url)) {
      return null;
    }
  }
  return {
    gen: state.gen,
    index: state.index,
    total: state.entries.length,
    playlist: state.name,
    title: entry.title,
    startS: entry.startS,
    endS: entry.endS ?? null,
    ads: entry.ads,
    view: entry.view ?? 'video',
    show: entry.show ?? null,
    speed: entry.speed ?? null,
  };
}

/**
 * The post's page read it (`page` source): keep what it said and move on to the card
 * page. Same gen: the card page belongs to this entry. `inPage` (it has an embedded
 * player): the page frames the card page itself, so the tab stays.
 */
async function pagePost(tabId: number, frameId: number, gen: number, result: PostResult, inPage: boolean): Promise<void> {
  const state = (await load())[tabId];
  if (frameId !== 0 || !state || state.gen !== gen || state.phase === 'detached') return;
  if (entryAt(state)?.view !== 'card' || state.card?.source !== 'page' || state.card.result) return;
  if (!result.ok) console.info(`[wtv] couldn't read the post from its page: ${result.error}`);
  // Gone, watching in TV mode or maximized: no card page to say so, straight on.
  if (!result.ok && result.gone && (await watchingFullView(tabId).catch(() => false))) {
    const entry = entryAt(state);
    if (entry) await updateMedia({ url: entry.url, status: 'gone' });
    await goTo(tabId, state, state.index + 1);
    return;
  }
  if (inPage && result.ok) {
    await put(tabId, { ...state, card: { source: 'page', result, inPage: true } });
    return;
  }
  await put(tabId, { ...state, phase: 'navigating', currentUrl: null, card: { source: 'page', result } });
  await browser.tabs.update(tabId, { url: cardPageUrl(gen) });
}

/**
 * The card page asks for its post. Not queued: the fetch can take seconds. Read from
 * its page if it was; otherwise (or if that failed and the site has an adapter) fetched.
 */
async function post(tabId: number, gen: number): Promise<PostResult> {
  const state = (await load())[tabId];
  const entry = state && state.gen === gen ? entryAt(state) : undefined;
  if (!entry || entry.view !== 'card') return { ok: false, gone: false, error: 'not a post entry any more' };
  const fromPage = state?.card?.result ?? null;
  const result =
    fromPage && (fromPage.ok || fromPage.gone || !findPostAdapter(entry.url)) ? fromPage : await fetchPost(entry.url);
  if (result.ok) {
    void updateMedia({
      url: entry.url,
      title: postTitle(result.post),
      creator: result.post.author,
      // Its first picture, as the entry's thumbnail (the page's og:image is often the site's).
      ...(result.post.images[0] ? { thumbnailUrl: result.post.images[0] } : {}),
      durationS: entry.endS ?? (state?.card?.inPage ? embedCardDurationS(result.post) : cardDurationS(result.post)),
    });
  }
  return result;
}

async function media(tabId: number, frameId: number, gen: number, event: MediaEvent): Promise<void> {
  const state = (await load())[tabId];
  if (!state || state.gen !== gen || state.phase === 'detached') return;
  const entry = entryAt(state);
  switch (event) {
    case 'playing':
      // The top frame lifts its own blackout; a player in a child frame needs us to.
      if (frameId !== 0) await toTop(tabId, { type: PL_APPLY, op: 'lift' });
      if (entry) void updateMedia({ url: entry.url, status: 'ok', lastPlayedAt: Date.now() });
      return;
    case 'gone': {
      if (!entry) return;
      console.info(`[wtv] playlist entry ${state.index + 1} is unavailable: ${entry.url}`);
      await updateMedia({ url: entry.url, status: 'gone' });
      // Watching in TV mode or maximized: no notice, straight on (the loading pictures stay up).
      if (await watchingFullView(tabId).catch(() => false)) {
        const now = (await load())[tabId];
        if (now && now.gen === gen && now.phase !== 'detached') await goTo(tabId, now, now.index + 1);
        return;
      }
      const key = libraryKey(entry.url);
      const known = key ? await getRecord(key).catch(() => null) : null;
      const title = entry.title ?? known?.title ?? displayTitle(entry);
      await toTop(tabId, { type: PL_APPLY, op: 'blackout', title: `Unavailable: ${title}`, notice: true, gen });
      setTimeout(() => {
        void serial(async () => {
          const now = (await load())[tabId];
          if (now && now.gen === gen && now.phase !== 'detached') await goTo(tabId, now, now.index + 1);
        });
      }, GONE_DWELL_MS);
      return;
    }
    case 'blocked':
      // An embedded player was refused autoplay: the top frame's blackout should offer
      // Start right away rather than waiting.
      if (frameId !== 0) await toTop(tabId, { type: PL_APPLY, op: 'blocked' });
      return;
    case 'near-end':
      if (!state.nearEnd) await put(tabId, { ...state, nearEnd: true });
      return;
    case 'ended':
      return goTo(tabId, state, state.index + 1);
  }
}

async function info(tabId: number, gen: number, report: MediaInfo): Promise<void> {
  const state = (await load())[tabId];
  if (!state || state.gen !== gen || state.phase === 'detached') return;
  const entry = entryAt(state);
  if (entry) await updateMedia({ url: entry.url, ...report });
}

async function tabUpdated(tabId: number, url: string | undefined, complete: boolean): Promise<void> {
  const state = (await load())[tabId];
  if (!state) return;
  // No Wtv on the entry's site (permission declined): no hello, so take the first web
  // page load as the entry.
  if (complete && state.phase === 'navigating') {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab?.url && isWebUrl(tab.url)) await put(tabId, { ...state, phase: 'playing', currentUrl: withoutHash(tab.url) });
    return;
  }
  if (!url || state.phase !== 'playing' || onEntry(state, url)) return;
  // A post's page being read for its card: SPAs tidy their address as they load. Same
  // site: still the post (somewhere else is the user leaving).
  // Same while its card shows on it (an embedded player).
  if (state.card?.source === 'page' && (!state.card.result || state.card.inPage) && sameHost(url, entryAt(state)?.url)) return;
  if (state.nearEnd) {
    await goTo(tabId, state, state.index + 1);
  } else {
    console.info(`[wtv] tab ${tabId} left playlist entry ${state.index + 1}; waiting for Resume`);
    await put(tabId, { ...state, phase: 'detached' });
    await toTop(tabId, { type: PL_APPLY, op: 'release' });
  }
}

async function summary(tabId: number): Promise<RunnerSummary | null> {
  return summarize((await load())[tabId]);
}

function summarize(state: RunnerState | undefined): RunnerSummary | null {
  const entry = state && entryAt(state);
  if (!state || !entry) return null;
  return {
    playlistId: state.playlistId,
    name: state.name,
    index: state.index,
    entry: playOrder(state)[state.index]!,
    total: state.entries.length,
    title: entry.title,
    url: entry.url,
    detached: state.phase === 'detached',
    shuffle: state.shuffle ?? false,
    loop: state.loop ?? false,
    lap: state.lap ?? 1,
  };
}

async function runs(): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  for (const [tabId, state] of Object.entries(await load())) {
    const s = summarize(state);
    if (s) out.push({ ...s, tabId: Number(tabId) });
  }
  return out;
}

/** Call synchronously at service-worker startup. */
export function startPlaylistRunner(): void {
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (r: unknown) => void) => {
    const msg = parsePlaylistRequest(raw);
    if (!msg) return undefined;
    const senderTab = sender.tab?.id;
    const reply = (task: () => Promise<unknown>) => {
      serial(task).then(sendResponse, (err: unknown) => {
        console.error('[wtv] playlist request failed:', err);
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      });
      return true;
    };

    switch (msg.type) {
      case PL_HELLO:
        if (senderTab === undefined || !sender.url) return undefined;
        return reply(() => hello(senderTab, sender.frameId ?? 0, sender.url!));
      case PL_MEDIA:
        if (senderTab === undefined) return undefined;
        void serial(() => media(senderTab, sender.frameId ?? 0, msg.gen, msg.event));
        return undefined;
      case PL_POST:
        if (senderTab === undefined) return undefined;
        post(senderTab, msg.gen).then(sendResponse, (err: unknown) =>
          sendResponse({ ok: false, gone: false, error: err instanceof Error ? err.message : String(err) }),
        );
        return true;
      case PL_PAGE_POST:
        if (senderTab === undefined) return undefined;
        void serial(() => pagePost(senderTab, sender.frameId ?? 0, msg.gen, msg.result, msg.inPage));
        return undefined;
      case PL_INFO:
        if (senderTab === undefined) return undefined;
        void serial(() => info(senderTab, msg.gen, msg.info));
        return undefined;
      case PL_STATE: {
        const tabId = senderTab ?? msg.tabId;
        return tabId === null ? undefined : reply(() => summary(tabId));
      }
      case PL_RUNS:
        return reply(runs);
      case PL_COMMAND: {
        if (msg.op === 'start') {
          const { playlistId, index, tv, shuffle, loop } = msg;
          return reply(() => start(playlistId, index, { tv, shuffle, loop }).then(() => true));
        }
        const tabId = senderTab ?? msg.tabId;
        return tabId === null ? undefined : reply(() => step(tabId, msg.op).then(() => true));
      }
    }
    return undefined;
  });

  browser.commands.onCommand.addListener((command, tab) => {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    if (command === PLAYLIST_COMMANDS.next) void serial(() => step(tabId, 'next'));
    else if (command === PLAYLIST_COMMANDS.previous) void serial(() => step(tabId, 'previous'));
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url === undefined && changeInfo.status !== 'complete') return;
    void serial(() => tabUpdated(tabId, changeInfo.url, changeInfo.status === 'complete'));
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void serial(async () => {
      if ((await load())[tabId]) await put(tabId, null);
    });
  });
}
