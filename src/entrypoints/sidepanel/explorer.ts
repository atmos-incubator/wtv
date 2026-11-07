/**
 * The side panel's Playlists view: browse and start playlists while watching. Built-in
 * and yours, most recently played first, searchable by playlist name and entry title.
 *
 * Each card's cover is a slow slideshow of its entries (the four most recently played
 * thumbnails, then the next four; titles on color blocks for entries without one; a
 * built-in's placeholder SVG until it has played). The playlist playing, and its entry,
 * are highlighted, with Next / Stop.
 *
 * Read-only: editing happens on the playlists page (Open).
 */
import { browser } from 'wxt/browser';
import { browserAreas } from '../../lib/browser-storage';
import { LIB_CHANGED } from '../../lib/media-library/messages';
import {
  coverSlots,
  describeLength,
  entryLengthS,
  formatClock,
  playlistLength,
  type MediaRecord,
} from '../../lib/media-library/record';
import { LibraryView } from '../../lib/media-library/thumbs';
import type { BuiltinPlaylist } from '../../lib/playlist/builtin';
import { BUILTIN_PLAYLISTS } from '../../lib/playlist/builtin-bundle';
import {
  describeAgo,
  explorerOrder,
  matchPlaylist,
  parsePlays,
  searchTerms,
  type PlaylistPlays,
  type SearchMatch,
} from '../../lib/playlist/explore';
import { compilePlaylist, parsePlaylist, type CompiledPlaylist } from '../../lib/playlist/format';
import { PL_COMMAND, PL_RUNS, type RunSummary, type StepOp } from '../../lib/playlist/messages';
import { PARTIAL_ACCESS_NOTE, playPlaylist, type PlayOptions } from '../../lib/playlist/play';
import { listPlaylists, type StoredPlaylist } from '../../lib/playlist/store';
import { KEYS, readKey } from '../../lib/storage';
import { cover, picture } from '../../lib/ui/cover';

/** How often a cover moves on to its next four. */
const CYCLE_MS = 6000;

type AnyPlaylist = StoredPlaylist | BuiltinPlaylist;
const isBuiltin = (p: AnyPlaylist): p is BuiltinPlaylist => 'builtin' in p;

const root = document.getElementById('playlists') as HTMLElement;
const local = browserAreas().local;
const library = new LibraryView();

let active = false;
/** Something changed while hidden: draw on show. */
let stale = true;
let mine: StoredPlaylist[] = [];
let plays: PlaylistPlays = {};
let runs: RunSummary[] = [];
let windowId: number | null = null;
let activeTabId: number | null = null;
let query = '';
/** Cards whose entry list is open. */
const expanded = new Set<string>();
let message: { text: string; warn: boolean } | null = null;

// --- DOM -------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text: string, onClick: () => void | Promise<void>, className = '', title = ''): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', () => {
    void Promise.resolve(onClick()).catch((err: unknown) => say(`Failed: ${(err as Error).message}`, true));
  });
  return b;
}

const search = el('input', 'search');
search.type = 'search';
search.placeholder = 'Search playlists and titles';
search.setAttribute('aria-label', 'Search playlists and entry titles');
const statusLine = el('p', 'status');
statusLine.setAttribute('aria-live', 'polite');
const cards = el('div', 'cards');
const emptyNote = el('p', 'note');

const head = el('div', 'explorer-head');
head.append(search, button('Playlists page', () => openPlaylistsPage(null), '', 'Make and edit playlists'));
root.append(head, statusLine, cards, emptyNote);

function say(text: string, warn = false): void {
  message = { text, warn };
  statusLine.textContent = text;
  statusLine.classList.toggle('warn', warn);
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = search.value;
    draw();
  }, 120);
});

// --- data ------------------------------------------------------------------------------

const compiledCache = new Map<string, CompiledPlaylist>();
function compiledOf(p: AnyPlaylist): CompiledPlaylist {
  let c = compiledCache.get(p.text);
  if (!c) {
    c = compilePlaylist(parsePlaylist(p.text));
    compiledCache.set(p.text, c);
  }
  return c;
}

async function loadPlaylists(): Promise<boolean> {
  mine = await listPlaylists(local);
  plays = parsePlays(await readKey<unknown>(local, KEYS.playlistPlays, {}));
  const texts = new Set([...mine, ...BUILTIN_PLAYLISTS].map((p) => p.text));
  for (const t of compiledCache.keys()) if (!texts.has(t)) compiledCache.delete(t);
  return true;
}

/** False: nothing the cards show changed (the runner saves its state more often than that). */
async function loadRuns(): Promise<boolean> {
  const before = JSON.stringify(runs);
  try {
    const r: unknown = await browser.runtime.sendMessage({ type: PL_RUNS });
    runs = Array.isArray(r) ? (r as RunSummary[]) : [];
  } catch {
    runs = [];
  }
  return JSON.stringify(runs) !== before;
}

/** The run to show for a playlist: the one in this window's active tab, else any. */
function runOf(id: string): RunSummary | null {
  const of = runs.filter((r) => r.playlistId === id);
  return of.find((r) => r.tabId === activeTabId) ?? of[0] ?? null;
}

function refreshSoon(load: () => Promise<boolean>): void {
  void load().then((changed) => {
    if (!changed) return;
    if (active) draw();
    else stale = true;
  });
}

// --- actions ---------------------------------------------------------------------------

async function play(p: AnyPlaylist, o: PlayOptions, what: string): Promise<void> {
  const result = await playPlaylist(p, o);
  if (!result.ok) say(`Couldn’t start “${p.name}”: ${result.error}`, true);
  else if (result.partial) say(`Playing “${p.name}”. ${PARTIAL_ACCESS_NOTE}`, true);
  else say(`Playing “${p.name}”${what} in a new tab.`);
}

async function step(run: RunSummary, op: StepOp): Promise<void> {
  await browser.runtime.sendMessage({ type: PL_COMMAND, op, tabId: run.tabId });
}

async function showTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined && tab.windowId !== windowId) await browser.windows.update(tab.windowId, { focused: true });
}

function openPlaylistsPage(id: string | null): void {
  const url = browser.runtime.getURL('/playlists.html') + (id ? `?id=${encodeURIComponent(id)}` : '');
  void browser.tabs.create({ url, windowId: windowId ?? undefined });
}

// --- rendering -------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function entryRow(
  p: AnyPlaylist,
  i: number,
  e: CompiledPlaylist['entries'][number],
  record: MediaRecord | null,
  current: boolean,
): HTMLLIElement {
  const li = el('li');
  li.classList.toggle('current', current);
  li.classList.toggle('gone', record?.status === 'gone');
  if (current) li.setAttribute('aria-current', 'true');
  const thumb = el('span', 'thumb');
  const src = library.src(record) ?? (isBuiltin(p) ? p.cover : null);
  if (src) thumb.append(picture(src));
  const length = entryLengthS(e, record?.durationS ?? null);
  const meta = [record?.status === 'gone' ? 'Unavailable' : null, length !== null ? formatClock(length) : record?.live ? 'live' : null, hostOf(e.url)];
  const go = button('▶', () => play(p, { index: i, tv: false }, ` from entry ${i + 1}`), 'icon', 'Play from here');
  go.setAttribute('aria-label', `Play from entry ${i + 1}`);
  li.append(
    thumb,
    el('span', 'entry-title', e.title ?? record?.title ?? e.url),
    go,
    el('span', 'entry-meta', meta.filter(Boolean).join(' · ')),
  );
  return li;
}

function nowPlaying(run: RunSummary): HTMLElement {
  const title = run.title ?? library.recordFor(run.url)?.title ?? hostOf(run.url);
  const where = run.tabId === activeTabId ? '' : ' in another tab';
  const box = el('div', 'now');
  box.append(
    el('p', 'now-line', `${run.detached ? 'Paused' : 'Now playing'}${where} · ${run.index + 1} / ${run.total}`),
    el('p', 'now-title', title),
  );
  const actions = el('div', 'actions');
  if (run.tabId !== activeTabId) actions.append(button('Show tab', () => showTab(run.tabId)));
  if (run.detached) actions.append(button('Resume', () => step(run, 'resume'), 'primary'));
  else actions.append(button(run.loop || run.index + 1 < run.total ? 'Next ⏭' : 'Finish', () => step(run, 'next')));
  actions.append(button('Stop', () => step(run, 'stop')));
  box.append(actions);
  return box;
}

function card(p: AnyPlaylist, match: SearchMatch): HTMLElement {
  const compiled = compiledOf(p);
  const { entries } = compiled;
  const run = runOf(p.id);
  // The run plays the playlist as it was when it started: only point at an entry that's still there.
  const currentEntry = run && entries[run.entry]?.url === run.url ? run.entry : null;
  const article = el('article', 'card');
  article.classList.toggle('playing', run !== null);

  // Head: cover + name. Hovering the cover plays its thumbnails full size.
  const tiles = coverSlots(entries, library.records).map((s) => ({
    src: library.src(s.record),
    title: s.title,
    key: s.key,
  }));
  const coverBox = cover({
    id: p.id,
    name: p.name,
    tiles,
    placeholder: isBuiltin(p) ? p.cover : null,
    cycleMs: CYCLE_MS,
  });

  const records = entries.map((e) => library.recordFor(e.url));
  const lengths = entries.map((e, i) => entryLengthS(e, records[i]?.durationS ?? null));
  const len = playlistLength(lengths);
  const meta = [
    isBuiltin(p) ? 'Built in' : null,
    `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
    len.unknown < entries.length ? `${describeLength({ totalS: len.totalS, unknown: 0 }, entries.length)}${len.unknown ? '+' : ''}` : null,
    p.id in plays ? `played ${describeAgo(plays[p.id]!, Date.now())}` : null,
  ];
  const head = el('div', 'card-head');
  head.append(coverBox, el('h2', '', p.name), el('p', 'meta', meta.filter(Boolean).join(' · ')));

  const playButtons = [
    button('▶ Play', () => play(p, { index: null, tv: false }, ''), 'primary'),
    button('TV mode', () => play(p, { index: null, tv: true }, ' in TV mode'), '', 'Play in TV mode: full screen, video only'),
    button('Shuffle', () => play(p, { index: null, tv: false, shuffle: true }, ', shuffled'), '', 'Play in a random order'),
  ];
  for (const b of playButtons) b.disabled = entries.length === 0;
  const actions = el('div', 'actions');
  actions.append(...playButtons, button('Open', () => openPlaylistsPage(p.id), '', 'Open it on the playlists page'));

  // Entries: all, or the ones the search found.
  const shown = match.nameMatch ? entries.map((_, i) => i) : match.entries;
  const details = el('details', 'entries');
  details.open = expanded.has(p.id) || !match.nameMatch;
  details.addEventListener('toggle', () => {
    if (!match.nameMatch) return;
    if (details.open) expanded.add(p.id);
    else expanded.delete(p.id);
  });
  details.append(
    el('summary', '', match.nameMatch ? 'Entries' : `${shown.length} matching entr${shown.length === 1 ? 'y' : 'ies'} of ${entries.length}`),
  );
  const list = el('ol');
  // Built lazily: a closed list costs nothing.
  const fill = () => {
    if (list.childElementCount > 0 || !details.open) return;
    list.append(...shown.map((i) => entryRow(p, i, entries[i]!, records[i] ?? null, currentEntry === i)));
  };
  details.addEventListener('toggle', fill);
  details.append(list);
  fill();

  article.append(head, ...(run ? [nowPlaying(run)] : []), actions, details);
  return article;
}

function draw(): void {
  stale = false;
  const terms = searchTerms(query);
  const all = [...mine, ...BUILTIN_PLAYLISTS].map((p) => ({ id: p.id, name: p.name, builtin: isBuiltin(p), p }));
  const shown: HTMLElement[] = [];
  for (const { p } of explorerOrder(all, plays)) {
    const titles = compiledOf(p).entries.map((e) => e.title ?? library.recordFor(e.url)?.title ?? null);
    const match = matchPlaylist(p.name, titles, terms);
    if (match) shown.push(card(p, match));
  }
  cards.replaceChildren(...shown);
  emptyNote.hidden = shown.length > 0;
  emptyNote.textContent =
    all.length === 0
      ? 'No playlists yet. Make one on the playlists page, or right-click any page → Add to Wtv playlist.'
      : `Nothing matches “${query.trim()}”.`;
  if (message) {
    statusLine.textContent = message.text;
    statusLine.classList.toggle('warn', message.warn);
  }
}

// --- wiring ----------------------------------------------------------------------------

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (KEYS.playlists in changes || KEYS.playlistPlays in changes)) refreshSoon(loadPlaylists);
  if (area === 'session' && KEYS.runner in changes) refreshSoon(loadRuns);
});

browser.runtime.onMessage.addListener((msg: unknown) => {
  if ((msg as { type?: unknown } | null)?.type === LIB_CHANGED) refreshSoon(() => library.load());
  return undefined;
});

browser.tabs.onActivated.addListener((info) => {
  if (info.windowId !== windowId) return;
  activeTabId = info.tabId;
  if (active && runs.length > 0) draw();
  else if (runs.length > 0) stale = true;
});

let ready: Promise<void> | null = null;

/** `win`: the window this panel is in. */
export function showExplorer(win: number | null): void {
  windowId = win;
  active = true;
  ready ??= (async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    await Promise.all([library.load(), loadPlaylists(), loadRuns()]);
  })();
  void ready.then(() => {
    if (active && stale) draw();
  });
}

export function hideExplorer(): void {
  active = false;
}
