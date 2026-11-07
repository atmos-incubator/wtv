/**
 * Playlists page: list, edit (as text), play, export. The text is the playlist; the
 * entries column is a live preview of what it parses to, filled in from the media library
 * (durations, thumbnails, titles, gone entries) for entries that have played.
 */
import './style.css';
import { browser } from 'wxt/browser';
import { browserAreas } from '../../lib/browser-storage';
import { getThumbnail, listRecords } from '../../lib/media-library/db';
import { LIB_CHANGED } from '../../lib/media-library/messages';
import {
  coverRecords,
  describeLength,
  entryLengthS,
  formatClock,
  libraryKey,
  playlistLength,
  thumbnailOriginsFor,
  type MediaRecord,
} from '../../lib/media-library/record';
import type { ProgramItem } from '../../lib/overlay/program';
import {
  compilePlaylist,
  parsePlaylist,
  serializePlaylist,
  withoutEntries,
  type CompiledPlaylist,
} from '../../lib/playlist/format';
import { originPatternsFor } from '../../lib/playlist/match';
import { PL_COMMAND } from '../../lib/playlist/messages';
import { deletePlaylist, listPlaylists, savePlaylist, type StoredPlaylist } from '../../lib/playlist/store';
import { BUNDLED_SITES } from '../../lib/sites/bundled';
import { KEYS } from '../../lib/storage';

const local = browserAreas().local;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $<HTMLUListElement>('list');
const empty = $('empty');
const editor = $('editor');
const nameInput = $<HTMLInputElement>('name');
const textInput = $<HTMLTextAreaElement>('text');
const dirtyNote = $('dirty');
const statusLine = $('status');
const problemsList = $<HTMLUListElement>('problems');
const entriesList = $<HTMLOListElement>('entries');
const tvBox = $<HTMLInputElement>('tv');
const shuffleBox = $<HTMLInputElement>('shuffle');
const loopBox = $<HTMLInputElement>('loop');
const lengthNote = $('length');
const removeGone = $<HTMLButtonElement>('remove-gone');

/** Thumbnail hosts the user said no to at Play: not asked for again. */
const DECLINED_THUMBNAILS = 'wtv.playlists.declinedThumbnailOrigins';

textInput.placeholder = 'Paste URLs here, one per line.\n\nhttps://www.youtube.com/watch?v=… | Title | t=1:37';

let playlists: StoredPlaylist[] = [];
let currentId: string | null = new URLSearchParams(location.search).get('id');
let dirty = false;
let compiled: CompiledPlaylist = compilePlaylist(parsePlaylist(''));
/** The text's [shuffle] / [loop] as last seen: the checkboxes follow them when they change. */
let lines = { shuffle: false, loop: false };
/** The media library, by key. */
let records = new Map<string, MediaRecord>();
/** Object URLs of cached thumbnails, by key, with the image URL each was cached from. */
const thumbs = new Map<string, { from: string; url: string }>();

function current(): StoredPlaylist | null {
  return playlists.find((p) => p.id === currentId) ?? null;
}

function setStatus(text: string, warn = false): void {
  statusLine.textContent = text;
  statusLine.classList.toggle('warn', warn);
}

function setDirty(on: boolean): void {
  dirty = on;
  dirtyNote.hidden = !on;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const formatTime = formatClock;

function recordFor(url: string): MediaRecord | null {
  const key = libraryKey(url);
  return key ? (records.get(key) ?? null) : null;
}

/** Re-read the library and the thumbnails that changed. */
async function loadLibrary(): Promise<void> {
  try {
    records = await listRecords();
  } catch (err) {
    console.warn('[wtv] could not read the media library:', err);
    return;
  }
  for (const r of records.values()) {
    const from = r.thumbnailCachedFrom;
    const have = thumbs.get(r.key);
    if (!from || have?.from === from) continue;
    const blob = await getThumbnail(r.key).catch(() => null);
    if (!blob) continue;
    if (have) URL.revokeObjectURL(have.url);
    thumbs.set(r.key, { from, url: URL.createObjectURL(blob) });
  }
}

/** The cached copy, else the thumbnail's own URL. */
function thumbSrc(record: MediaRecord | null): string | null {
  return (record && thumbs.get(record.key)?.url) ?? record?.thumbnailUrl ?? null;
}

function picture(src: string): HTMLImageElement {
  const img = el('img');
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = src;
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

function thumbnail(record: MediaRecord | null): HTMLElement {
  const box = el('span', 'thumb');
  const src = thumbSrc(record);
  if (src) box.append(picture(src));
  return box;
}

/** Frame length of the hover slideshow on a playlist's cover. */
const COVER_SLIDE_MS = 1200;

/** A stable hue per playlist for its placeholder. */
function hueOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * A playlist's cover, thumbnail-sized: the four most recently played entries' thumbnails
 * in a quad (or the one, with fewer than four), else the name on a color block. Hovering
 * (or focusing) `row` plays every thumbnail full size, COVER_SLIDE_MS each.
 */
function cover(p: StoredPlaylist, srcs: readonly string[], row: HTMLElement): HTMLElement {
  const box = el('span', 'cover');
  if (srcs.length === 0) {
    box.classList.add('placeholder');
    box.style.setProperty('--hue', String(hueOf(p.id)));
    box.append(el('span', '', p.name));
    return box;
  }
  if (srcs.length >= 4) {
    box.classList.add('quad');
    box.append(...srcs.slice(0, 4).map(picture));
  } else {
    box.append(picture(srcs[0]!));
  }
  if (srcs.length < 2) return box;

  let timer: ReturnType<typeof setInterval> | undefined;
  let slide: HTMLImageElement | null = null;
  const start = () => {
    if (timer !== undefined) return;
    let i = 0;
    slide = picture(srcs[0]!);
    slide.className = 'slide';
    box.append(slide);
    timer = setInterval(() => {
      i = (i + 1) % srcs.length;
      if (slide) slide.src = srcs[i]!;
    }, COVER_SLIDE_MS);
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    slide?.remove();
    slide = null;
  };
  row.addEventListener('pointerenter', start);
  row.addEventListener('pointerleave', stop);
  row.addEventListener('focus', start);
  row.addEventListener('blur', stop);
  return box;
}

/** "1:30" for a whole video; "1:30 of 4:13" for part of one. */
function describeEntryLength(length: number | null, record: MediaRecord | null): string | null {
  if (record?.live && length === null) return 'live';
  if (length === null) return null;
  const whole = record?.durationS ?? null;
  return whole !== null && Math.abs(whole - length) >= 1 ? `${formatClock(length)} of ${formatClock(whole)}` : formatClock(length);
}

function describeProgram(label: string, items: ProgramItem[] | null, isDefault: boolean): string {
  if (!items) return `${label}: site pictures`;
  const quotes = items.filter((a) => a.kind === 'text').length;
  const imgs = items.length - quotes;
  const parts = [quotes && `${quotes} quote${quotes > 1 ? 's' : ''}`, imgs && `${imgs} picture set${imgs > 1 ? 's' : ''}`];
  return `${label}${isDefault ? ' (default)' : ''}: ${parts.filter(Boolean).join(', ')}`;
}

// --- rendering ---------------------------------------------------------------------

function renderList(): void {
  list.replaceChildren(
    ...playlists.map((p) => {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(p.id === currentId));
      const { entries } = compilePlaylist(parsePlaylist(p.text));
      const n = entries.length;
      const srcs = coverRecords(
        entries.map((e) => e.url),
        records,
      )
        .map(thumbSrc)
        .filter((s): s is string => s !== null);
      b.append(
        cover(p, srcs, b),
        el('span', 'name', p.name),
        el('span', 'count', `${n} entr${n === 1 ? 'y' : 'ies'}`),
      );
      b.addEventListener('click', () => void select(p.id));
      const li = el('li');
      li.append(b);
      return li;
    }),
  );
  empty.hidden = playlists.length > 0;
}

function renderPreview(): void {
  compiled = compilePlaylist(parsePlaylist(textInput.value));
  if (compiled.shuffle !== lines.shuffle) shuffleBox.checked = compiled.shuffle;
  if (compiled.loop !== lines.loop) loopBox.checked = compiled.loop;
  lines = { shuffle: compiled.shuffle, loop: compiled.loop };
  problemsList.replaceChildren(...compiled.problems.map((p) => el('li', '', `Line ${p.line}: ${p.message}`)));

  const lengths: (number | null)[] = [];
  const gone: number[] = [];
  if (compiled.entries.length === 0) {
    entriesList.replaceChildren(el('p', 'note', 'No entries yet.'));
  } else {
    entriesList.replaceChildren(
      ...compiled.entries.map((e, i) => {
        let host = e.url;
        try {
          host = new URL(e.url).hostname;
        } catch {
          // Shown as-is.
        }
        const record = recordFor(e.url);
        const length = entryLengthS(e, record?.durationS ?? null);
        lengths.push(length);
        const meta: string[] = [];
        if (record?.status === 'gone') {
          gone.push(i);
          meta.push('Unavailable');
        }
        const lengthText = describeEntryLength(length, record);
        if (lengthText) meta.push(lengthText);
        meta.push(host);
        if (e.startS !== null && e.endS !== null) meta.push(`${formatTime(e.startS)}–${formatTime(e.endS)}`);
        else if (e.startS !== null) meta.push(`from ${formatTime(e.startS)}`);
        else if (e.endS !== null) meta.push(`until ${formatTime(e.endS)}`);
        if (e.view === 'pictures') {
          // The show's pictures fall back to the ads program; say which one it is.
          const label = e.show !== null && e.show === e.ads ? 'shown as pictures, from its ads' : 'shown as pictures';
          meta.push(describeProgram(label, e.show, e.show !== null && e.show === compiled.defaultShow));
        }
        meta.push(describeProgram('ads', e.ads, e.ads !== null && e.ads === compiled.defaultAds));
        const li = el('li');
        li.classList.toggle('gone', record?.status === 'gone');
        const play = el('button', '', '▶');
        play.type = 'button';
        play.title = 'Play from here';
        play.setAttribute('aria-label', `Play from entry ${i + 1}`);
        play.addEventListener('click', () => void playFrom(i));
        li.append(
          thumbnail(record),
          el('span', 'entry-title', e.title ?? record?.title ?? e.url),
          play,
          el('span', 'entry-meta', meta.join(' · ')),
        );
        return li;
      }),
    );
  }
  lengthNote.textContent = describeLength(playlistLength(lengths), compiled.entries.length);
  removeGone.hidden = gone.length === 0;
  removeGone.textContent = `Remove gone entries (${gone.length})`;
  removeGone.dataset.entries = gone.join(',');
  $<HTMLButtonElement>('play').disabled = compiled.entries.length === 0;
}

function renderEditor(): void {
  const p = current();
  editor.hidden = !p;
  if (!p) return;
  nameInput.value = p.name;
  textInput.value = p.text;
  setDirty(false);
  setStatus('');
  renderPreview();
  // A playlist just opened: its lines decide, whatever was ticked for the last one.
  shuffleBox.checked = compiled.shuffle;
  loopBox.checked = compiled.loop;
}

// --- actions -----------------------------------------------------------------------

async function refresh(): Promise<void> {
  playlists = await listPlaylists(local);
  if (!current()) currentId = playlists[0]?.id ?? null;
  renderList();
}

async function select(id: string): Promise<void> {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  currentId = id;
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  renderList();
  renderEditor();
}

async function save(): Promise<StoredPlaylist | null> {
  const p = current();
  if (!p) return null;
  const saved = await savePlaylist(local, { id: p.id, name: nameInput.value, text: textInput.value });
  setDirty(false);
  await refresh();
  nameInput.value = saved.name;
  return saved;
}

/** `index`: an entry's ▶ (it plays first); null: ▶ Play (from the top, or anywhere when shuffling). */
async function playFrom(index: number | null): Promise<void> {
  const p = dirty ? await save() : current();
  if (!p) return;
  const { entries } = compilePlaylist(parsePlaylist(p.text));
  if (entries.length === 0) return;

  // Wtv only runs where it has host access: ask for every entry's site up front, in this
  // click, so the runner can detect each video's end. And for the sites' thumbnail hosts,
  // so the media library can cache thumbnails, unless the user said no to those before.
  const urls = entries.map((e) => e.url);
  const origins = originPatternsFor(urls);
  const declined = declinedThumbnails();
  const thumbnailOrigins = thumbnailOriginsFor(urls, BUNDLED_SITES).filter((o) => !declined.has(o));
  let granted = await browser.permissions.contains({ origins });
  const thumbsGranted = await browser.permissions.contains({ origins: thumbnailOrigins });
  if (!granted || !thumbsGranted) {
    const asked = [...origins, ...thumbnailOrigins];
    const ok = await browser.permissions.request({ origins: asked }).catch(() => false);
    if (!ok && !thumbsGranted) rememberDeclined([...declined, ...thumbnailOrigins]);
    granted = ok || (await browser.permissions.contains({ origins }));
  }

  const result: unknown = await browser.runtime.sendMessage({
    type: PL_COMMAND,
    op: 'start',
    playlistId: p.id,
    index,
    tv: tvBox.checked,
    shuffle: shuffleBox.checked,
    loop: loopBox.checked,
  });
  const error = (result as { error?: unknown } | null)?.error;
  if (typeof error === 'string') setStatus(`Couldn’t start: ${error}`, true);
  else if (!granted) {
    setStatus('Playing. Without site access Wtv can’t tell when some videos end there; use Next (Alt+Shift+N).', true);
  } else setStatus(`Playing “${p.name}” in a new tab.`);
}

function declinedThumbnails(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DECLINED_THUMBNAILS) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberDeclined(origins: readonly string[]): void {
  try {
    localStorage.setItem(DECLINED_THUMBNAILS, JSON.stringify([...new Set(origins)]));
  } catch {
    // Storage blocked: we'll ask again next time.
  }
}

removeGone.addEventListener('click', () => {
  const indexes = new Set((removeGone.dataset.entries ?? '').split(',').filter(Boolean).map(Number));
  if (indexes.size === 0) return;
  textInput.value = serializePlaylist(withoutEntries(parsePlaylist(textInput.value), indexes));
  setDirty(true);
  renderPreview();
  setStatus(`Removed ${indexes.size} unavailable entr${indexes.size === 1 ? 'y' : 'ies'}. Save to keep the change.`);
});

// The runner learned something (a duration, a thumbnail, a gone video).
browser.runtime.onMessage.addListener((msg: unknown) => {
  if ((msg as { type?: unknown } | null)?.type !== LIB_CHANGED) return undefined;
  void loadLibrary().then(() => {
    renderList();
    if (current()) renderPreview();
  });
  return undefined;
});

$('new').addEventListener('click', () => {
  void (async () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setDirty(false);
    const p = await savePlaylist(local, { name: '', text: '' });
    await refresh();
    await select(p.id);
    nameInput.select();
  })();
});

$('save').addEventListener('click', () => {
  void save().then((p) => p && setStatus('Saved.'));
});

$('play').addEventListener('click', () => void playFrom(null));

$('copy').addEventListener('click', () => {
  navigator.clipboard
    .writeText(textInput.value)
    .then(() => setStatus('Copied the playlist text to the clipboard.'))
    .catch(() => setStatus('Couldn’t copy. Select the text and copy it instead.', true));
});

$('delete').addEventListener('click', () => {
  const p = current();
  if (!p || !confirm(`Delete “${p.name}”? This can’t be undone.`)) return;
  void (async () => {
    await deletePlaylist(local, p.id);
    setDirty(false);
    currentId = null;
    await refresh();
    renderEditor();
  })();
});

let previewTimer: ReturnType<typeof setTimeout> | undefined;
textInput.addEventListener('input', () => {
  setDirty(true);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
});
nameInput.addEventListener('input', () => setDirty(true));

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    void save().then((p) => p && setStatus('Saved.'));
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

// Playlists changed elsewhere (context menu, another tab).
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(KEYS.playlists in changes)) return;
  void (async () => {
    await refresh();
    if (dirty) return;
    // Only reload the editor if the stored copy really differs (our own saves land here
    // too, and reloading would lose the cursor position).
    const p = current();
    if (!p || p.text !== textInput.value || p.name !== nameInput.value) renderEditor();
  })();
});

void loadLibrary()
  .then(refresh)
  .then(renderEditor);
