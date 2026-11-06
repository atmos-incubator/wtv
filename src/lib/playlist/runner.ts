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
 * The playlist is snapshotted when it starts; edits apply the next time it's played.
 */
import { browser } from 'wxt/browser';
import { browserAreas } from '../browser-storage';
import { isWebUrl } from '../permissions';
import { KEYS } from '../storage';
import { setTvMode } from '../view/controller';
import { compilePlaylist, parsePlaylist } from './format';
import { withWtvHash } from './hash';
import { sameEntryUrl } from './match';
import {
  PL_APPLY,
  PL_COMMAND,
  PL_HELLO,
  PL_MEDIA,
  PL_STATE,
  parsePlaylistRequest,
  type EntryInfo,
  type MediaEvent,
  type PlaylistApply,
  type RunnerSummary,
  type StepOp,
} from './messages';
import { getPlaylist } from './store';
import type { ProgramItem } from '../overlay/program';

interface RunEntry {
  url: string;
  title: string | null;
  startS: number | null;
  ads: ProgramItem[] | null;
}

export interface RunnerState {
  playlistId: string;
  name: string;
  entries: RunEntry[];
  index: number;
  gen: number;
  /** navigating: waiting for the entry's page. playing: on it. detached: user went elsewhere. */
  phase: 'navigating' | 'playing' | 'detached';
  /** The entry's URL as the tab actually shows it (after redirects). */
  currentUrl: string | null;
  nearEnd: boolean;
}

type RunnerStore = Record<string, RunnerState>;

export const PLAYLIST_COMMANDS = { next: 'next', previous: 'previous' } as const;

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
  if (index >= state.entries.length) {
    console.info(`[wtv] playlist "${state.name}" finished in tab ${tabId}`);
    await put(tabId, null);
    await toTop(tabId, { type: PL_APPLY, op: 'lift' });
    return;
  }
  const i = Math.max(0, index);
  const entry = state.entries[i]!;
  const next: RunnerState = { ...state, index: i, gen: state.gen + 1, phase: 'navigating', currentUrl: null, nearEnd: false };
  await put(tabId, next);
  // Go dark on the page we're leaving, so its end screen / autoplay never shows.
  await toTop(tabId, { type: PL_APPLY, op: 'blackout', title: displayTitle(entry) });
  // The #wtv: hash lets the new page black out (and know its start time) before it
  // paints, without waiting for the hello round trip.
  await browser.tabs.update(tabId, { url: withWtvHash(entry.url, { t: entry.startS, title: entry.title }) });
}

async function start(playlistId: string, index: number, tv: boolean): Promise<void> {
  const playlist = await getPlaylist(browserAreas().local, playlistId);
  if (!playlist) throw new Error(`no playlist ${playlistId}`);
  const { entries } = compilePlaylist(parsePlaylist(playlist.text));
  if (entries.length === 0) throw new Error(`playlist "${playlist.name}" has no entries`);

  // Open the tab first and save the state before navigating, so the first page's hello
  // finds it.
  const tab = await browser.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined) throw new Error('could not open a tab');
  const state: RunnerState = {
    playlistId,
    name: playlist.name,
    entries: entries.map(({ url, title, startS, ads }) => ({ url, title, startS, ads })),
    index: 0,
    gen: 0,
    phase: 'navigating',
    currentUrl: null,
    nearEnd: false,
  };
  await put(tab.id, state);
  if (tv) await setTvMode(tab.id, true);
  await goTo(tab.id, state, Math.min(index, entries.length - 1));
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
    case 'stop':
      await put(tabId, null);
      await toTop(tabId, { type: PL_APPLY, op: 'lift' });
      return;
  }
}

function onEntry(state: RunnerState, url: string): boolean {
  const entry = state.entries[state.index];
  if (!entry) return false;
  return sameEntryUrl(url, entry.url) || (state.currentUrl !== null && sameEntryUrl(url, state.currentUrl));
}

async function hello(tabId: number, frameId: number, url: string): Promise<EntryInfo | null> {
  const state = (await load())[tabId];
  if (!state || state.phase === 'detached') return null;
  const entry = state.entries[state.index];
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
    ads: entry.ads,
  };
}

async function media(tabId: number, frameId: number, gen: number, event: MediaEvent): Promise<void> {
  const state = (await load())[tabId];
  if (!state || state.gen !== gen || state.phase === 'detached') return;
  switch (event) {
    case 'playing':
      // The top frame lifts its own blackout; a player in a child frame needs us to.
      if (frameId !== 0) await toTop(tabId, { type: PL_APPLY, op: 'lift' });
      return;
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
  if (state.nearEnd) {
    await goTo(tabId, state, state.index + 1);
  } else {
    console.info(`[wtv] tab ${tabId} left playlist entry ${state.index + 1}; waiting for Resume`);
    await put(tabId, { ...state, phase: 'detached' });
    await toTop(tabId, { type: PL_APPLY, op: 'lift' });
  }
}

async function summary(tabId: number): Promise<RunnerSummary | null> {
  const state = (await load())[tabId];
  const entry = state?.entries[state.index];
  if (!state || !entry) return null;
  return {
    playlistId: state.playlistId,
    name: state.name,
    index: state.index,
    total: state.entries.length,
    title: entry.title,
    url: entry.url,
    detached: state.phase === 'detached',
  };
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
      case PL_STATE: {
        const tabId = senderTab ?? msg.tabId;
        return tabId === null ? undefined : reply(() => summary(tabId));
      }
      case PL_COMMAND: {
        if (msg.op === 'start') return reply(() => start(msg.playlistId, msg.index, msg.tv).then(() => true));
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
