/**
 * Playlists page: list, edit (as text), play, export; built-in playlists (read-only,
 * Duplicate to edit); backup / restore of everything. The text is the playlist; the
 * entries column is a live preview of what it parses to, filled in from the media library
 * (durations, thumbnails, titles, gone entries) for entries that have played.
 */
import './style.css';
import { browser } from 'wxt/browser';
import {
  backupFileName,
  describePlan,
  makeBackup,
  parseBackup,
  planChangesAnything,
  planImport,
} from '../../lib/backup';
import { browserAreas } from '../../lib/browser-storage';
import { reloadKeepingPages, takePlaylistDraft } from '../../lib/dev/reload';
import { DEV_TOOLS } from '../../lib/env';
import { LIB_CHANGED } from '../../lib/media-library/messages';
import {
  coverRecords,
  describeLength,
  entryLengthS,
  formatClock,
  playlistLength,
  type MediaRecord,
} from '../../lib/media-library/record';
import { LibraryView } from '../../lib/media-library/thumbs';
import type { ProgramItem } from '../../lib/overlay/program';
import { DEFAULT_SCROLL_PX_S, DEFAULT_WPM } from '../../lib/page-show/pace';
import {
  compilePlaylist,
  isMediaView,
  parsePlaylist,
  serializePlaylist,
  withoutEntries,
  type CompiledPlaylist,
} from '../../lib/playlist/format';
import { PARTIAL_ACCESS_NOTE, playPlaylist } from '../../lib/playlist/play';
import type { BuiltinPlaylist } from '../../lib/playlist/builtin';
import { BUILTIN_PLAYLISTS } from '../../lib/playlist/builtin-bundle';
import {
  deletePlaylist,
  listPlaylists,
  loadPlaylistStore,
  savePlaylist,
  savePlaylistStore,
  type StoredPlaylist,
} from '../../lib/playlist/store';
import { parseSettings } from '../../lib/settings';
import { loadOverrideStore, saveOverrideStore } from '../../lib/sites/override-store';
import type { OverrideStore } from '../../lib/sites/overrides';
import { BUNDLED_SITES } from '../../lib/sites/bundled';
import { findPostAdapter } from '../../lib/posts/adapters';
import { cardSource } from '../../lib/posts/source';
import { KEYS, readKey, writeKey } from '../../lib/storage';
import { cover, picture } from '../../lib/ui/cover';
import { linkLines } from './line-link';

const local = browserAreas().local;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $<HTMLUListElement>('list');
const builtinHeading = $('builtin-heading');
const builtinList = $<HTMLUListElement>('builtin-list');
const builtinNote = $('builtin-note');
const backupStatus = $('backup-status');
const importFile = $<HTMLInputElement>('import-file');
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

textInput.placeholder = 'Paste URLs here, one per line.\n\nhttps://www.youtube.com/watch?v=… | Title | t=1:37';

/** The pointer over an entry's line in the text: that entry stands out in the list, and back. */
const lineLink = linkLines(textInput, (line) => {
  const index = line === null ? -1 : compiled.entries.findIndex((e) => e.line === line);
  entriesList.querySelectorAll(':scope > li').forEach((li, i) => li.classList.toggle('hl', i === index));
});

type AnyPlaylist = StoredPlaylist | BuiltinPlaylist;
const isBuiltin = (p: AnyPlaylist | null): p is BuiltinPlaylist => p !== null && 'builtin' in p;

let playlists: StoredPlaylist[] = [];
/** Selector overrides: whether a site's posts are read from their pages (describeCard). */
let overrides: OverrideStore = {};
let currentId: string | null = new URLSearchParams(location.search).get('id');
let dirty = false;
let compiled: CompiledPlaylist = compilePlaylist(parsePlaylist(''));
/** The text's [shuffle] / [loop] as last seen: the checkboxes follow them when they change. */
let lines = { shuffle: false, loop: false };
/** The media library, with its cached thumbnails. */
const library = new LibraryView();

function current(): AnyPlaylist | null {
  return playlists.find((p) => p.id === currentId) ?? BUILTIN_PLAYLISTS.find((p) => p.id === currentId) ?? null;
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

/** `placeholder`: a built-in's cover SVG, for entries with no thumbnail yet. */
function thumbnail(record: MediaRecord | null, placeholder: string | null): HTMLElement {
  const box = el('span', 'thumb');
  const src = library.src(record) ?? placeholder;
  if (src) box.append(picture(src));
  return box;
}

/** "1:30" for a whole video; "1:30 of 4:13" for part of one. */
function describeEntryLength(length: number | null, record: MediaRecord | null): string | null {
  if (record?.live && length === null) return 'live';
  if (length === null) return null;
  const whole = record?.durationS ?? null;
  return whole !== null && Math.abs(whole - length) >= 1 ? `${formatClock(length)} of ${formatClock(whole)}` : formatClock(length);
}

/** Where a card's post comes from (posts/source.ts), or why it can't play. */
function describeCard(url: string): string {
  const source = cardSource(url, BUNDLED_SITES, overrides);
  if (source === 'page') return 'a post, on a title card: read from its page with your post selectors';
  if (source === 'api') return `a post, on a title card: from ${findPostAdapter(url)?.adapter.site ?? 'the site'}’s public data`;
  return '⚠ a post card needs post selectors for this site: open a post there, then Fix selectors → Posts';
}

function describeProgram(label: string, items: ProgramItem[] | null, isDefault: boolean): string {
  if (!items) return `${label}: site pictures`;
  const quotes = items.filter((a) => a.kind === 'text').length;
  const imgs = items.length - quotes;
  const parts = [quotes && `${quotes} quote${quotes > 1 ? 's' : ''}`, imgs && `${imgs} picture set${imgs > 1 ? 's' : ''}`];
  return `${label}${isDefault ? ' (default)' : ''}: ${parts.filter(Boolean).join(', ')}`;
}

// --- rendering ---------------------------------------------------------------------

function playlistItem(p: AnyPlaylist): HTMLLIElement {
  const b = el('button');
  b.type = 'button';
  b.setAttribute('aria-current', String(p.id === currentId));
  const { entries } = compilePlaylist(parsePlaylist(p.text));
  const n = entries.length;
  // Only entries with a thumbnail: a quad once four have one, else the latest.
  const tiles = coverRecords(
    entries.map((e) => e.url),
    library.records,
  ).map((r) => ({ src: library.src(r), title: r.title ?? r.url, key: r.key }));
  b.append(
    cover({ id: p.id, name: p.name, tiles, placeholder: isBuiltin(p) ? p.cover : null, hoverTarget: b }),
    el('span', 'name', p.name),
    el('span', 'count', `${n} entr${n === 1 ? 'y' : 'ies'}`),
  );
  b.addEventListener('click', () => void select(p.id));
  const li = el('li');
  li.append(b);
  return li;
}

function renderList(): void {
  list.replaceChildren(...playlists.map(playlistItem));
  empty.hidden = playlists.length > 0;
  builtinList.replaceChildren(...BUILTIN_PLAYLISTS.map(playlistItem));
  builtinHeading.hidden = builtinList.hidden = BUILTIN_PLAYLISTS.length === 0;
}

function renderPreview(): void {
  compiled = compilePlaylist(parsePlaylist(textInput.value));
  if (compiled.shuffle !== lines.shuffle) shuffleBox.checked = compiled.shuffle;
  if (compiled.loop !== lines.loop) loopBox.checked = compiled.loop;
  lines = { shuffle: compiled.shuffle, loop: compiled.loop };
  problemsList.replaceChildren(...compiled.problems.map((p) => el('li', '', `Line ${p.line}: ${p.message}`)));

  const lengths: (number | null)[] = [];
  const gone: number[] = [];
  const shown = current();
  const placeholder = isBuiltin(shown) ? shown.cover : null;
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
        const record = library.recordFor(e.url);
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
        else if (e.endS !== null) meta.push(isMediaView(e.view) ? `until ${formatTime(e.endS)}` : `for ${formatTime(e.endS)}`);
        if (e.view === 'read') meta.push(`read as an article, ${e.speed ?? DEFAULT_WPM} wpm`);
        else if (e.view === 'scroll') meta.push(`the page, scrolled ${e.speed ?? DEFAULT_SCROLL_PX_S} px/s`);
        else if (e.view === 'card') meta.push(describeCard(e.url));
        if (e.view === 'pictures') {
          // The show's pictures fall back to the ads program; say which one it is.
          const label = e.show !== null && e.show === e.ads ? 'shown as pictures, from its ads' : 'shown as pictures';
          meta.push(describeProgram(label, e.show, e.show !== null && e.show === compiled.defaultShow));
        }
        if (isMediaView(e.view)) meta.push(describeProgram('ads', e.ads, e.ads !== null && e.ads === compiled.defaultAds));
        const li = el('li');
        li.classList.toggle('gone', record?.status === 'gone');
        // Hover: its line stands out in the text; a click (not on ▶ / ↗) scrolls the text to it.
        li.addEventListener('mouseenter', () => lineLink.highlight(e.line));
        li.addEventListener('mouseleave', () => lineLink.highlight(null));
        li.addEventListener('click', (ev) => {
          if ((ev.target as Element).closest('button, a')) return;
          lineLink.reveal(e.line);
        });
        li.title = `Line ${e.line + 1}: click to go to it in the text`;
        const play = el('button', '', '▶');
        play.type = 'button';
        play.title = 'Play from here';
        play.setAttribute('aria-label', `Play from entry ${i + 1}`);
        play.addEventListener('click', () => void playFrom(i));
        const actions = el('span', 'entry-actions');
        actions.append(play);
        // Just the page, in a tab of its own (no playlist, no TV): for looking at one entry.
        if (/^https?:\/\//i.test(e.url)) {
          const open = Object.assign(el('a', 'button', '↗'), { href: e.url, target: '_blank', rel: 'noopener' });
          open.title = 'Open the page on its own (not as a playlist)';
          open.setAttribute('aria-label', `Open entry ${i + 1} on its own`);
          actions.append(open);
        }
        li.append(
          thumbnail(record, placeholder),
          el('span', 'entry-title', e.title ?? record?.title ?? e.url),
          actions,
          el('span', 'entry-meta', meta.join(' · ')),
        );
        return li;
      }),
    );
  }
  lengthNote.textContent = describeLength(playlistLength(lengths), compiled.entries.length);
  removeGone.hidden = gone.length === 0 || isBuiltin(current());
  removeGone.textContent = `Remove gone entries (${gone.length})`;
  removeGone.dataset.entries = gone.join(',');
  $<HTMLButtonElement>('play').disabled = compiled.entries.length === 0;
}

function renderEditor(): void {
  const p = current();
  editor.hidden = !p;
  if (!p) return;
  const builtin = isBuiltin(p);
  nameInput.value = p.name;
  textInput.value = p.text;
  nameInput.readOnly = textInput.readOnly = builtin;
  builtinNote.hidden = !builtin;
  $('save').hidden = $('delete').hidden = builtin;
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
  if (!current()) currentId = playlists[0]?.id ?? BUILTIN_PLAYLISTS[0]?.id ?? null;
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
  if (!p || isBuiltin(p)) return null;
  const saved = await savePlaylist(local, { id: p.id, name: nameInput.value, text: textInput.value });
  setDirty(false);
  await refresh();
  nameInput.value = saved.name;
  return saved;
}

/** `index`: an entry's ▶ (it plays first); null: ▶ Play (from the top, or anywhere when shuffling). */
async function playFrom(index: number | null): Promise<void> {
  const p: AnyPlaylist | null = dirty ? await save() : current();
  if (!p) return;
  if (compilePlaylist(parsePlaylist(p.text)).entries.length === 0) return;
  const result = await playPlaylist(p, { index, tv: tvBox.checked, shuffle: shuffleBox.checked, loop: loopBox.checked });
  if (!result.ok) setStatus(`Couldn’t start: ${result.error}`, true);
  else if (result.partial) setStatus(`Playing. ${PARTIAL_ACCESS_NOTE}`, true);
  else setStatus(`Playing “${p.name}” in a new tab.`);
}

$('duplicate').addEventListener('click', () => {
  const p = current();
  if (!p) return;
  if (dirty && !confirm('Duplicate the saved version? Your unsaved changes stay unsaved here.')) return;
  void (async () => {
    const copy = await savePlaylist(local, { name: isBuiltin(p) ? p.name : `${p.name} copy`, text: p.text });
    setDirty(false);
    await refresh();
    await select(copy.id);
    setStatus(isBuiltin(p) ? 'Your own copy: edit away.' : 'Duplicated.');
  })();
});

// --- backup / restore ----------------------------------------------------------------

function setBackupStatus(text: string, warn = false): void {
  backupStatus.textContent = text;
  backupStatus.classList.toggle('warn', warn);
}

$('export').addEventListener('click', () => {
  void (async () => {
    const backup = makeBackup({
      playlists: await loadPlaylistStore(local),
      overrides: await loadOverrideStore(local),
      settings: parseSettings(await readKey<unknown>(local, KEYS.settings, undefined)),
    });
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: backupFileName() });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    const n = backup.playlists.length;
    setBackupStatus(`Exported ${n} playlist${n === 1 ? '' : 's'}, your selectors and settings. Pictures aren’t included.`);
  })().catch((err: unknown) => setBackupStatus(`Couldn’t export: ${String(err)}`, true));
});

$('import').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  importFile.value = '';
  importFile.click();
});

importFile.addEventListener('change', () => {
  const file = importFile.files?.[0];
  if (!file) return;
  void (async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setBackupStatus(`${file.name} isn’t a Wtv backup file.`, true);
      return;
    }
    const parsed = parseBackup(raw);
    if (!parsed.ok) {
      setBackupStatus(parsed.error, true);
      return;
    }
    const plan = planImport(
      {
        playlists: await loadPlaylistStore(local),
        overrides: await loadOverrideStore(local),
        settings: parseSettings(await readKey<unknown>(local, KEYS.settings, undefined)),
      },
      parsed.backup,
    );
    const skipped = parsed.warnings.length ? `\n\nSkipped:\n${parsed.warnings.join('\n')}` : '';
    if (!planChangesAnything(plan)) {
      setBackupStatus(`Nothing to import: everything already matches ${file.name}.`);
      return;
    }
    if (!confirm(`Import ${file.name}?\n\n${describePlan(plan)}${skipped}`)) return;
    await savePlaylistStore(local, plan.next.playlists);
    await saveOverrideStore(local, plan.next.overrides);
    await writeKey(local, KEYS.settings, plan.next.settings);
    setDirty(false);
    await refresh();
    renderEditor();
    const n = plan.added.length + plan.replaced.length;
    setBackupStatus(
      `Imported ${n} playlist${n === 1 ? '' : 's'}${plan.overrides.length ? ', selectors' : ''}${plan.settingsChanged ? ', settings' : ''}.` +
        (parsed.warnings.length ? ` ${parsed.warnings.length} item(s) skipped.` : ''),
      parsed.warnings.length > 0,
    );
  })().catch((err: unknown) => setBackupStatus(`Couldn’t import: ${String(err)}`, true));
});

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
  void library.load().then(() => {
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

// Selectors saved in the side panel change where cards come from.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(KEYS.siteOverrides in changes)) return;
  void loadOverrideStore(local).then((store) => {
    overrides = store;
    renderPreview();
  });
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

if (DEV_TOOLS) {
  $('dev').hidden = false;
  const reload = $<HTMLButtonElement>('reload-wtv');
  reload.addEventListener('click', () => {
    reload.disabled = true;
    const p = current();
    const draft = dirty && p && !isBuiltin(p) ? { id: p.id, name: nameInput.value, text: textInput.value } : null;
    // Nothing to lose now: the draft goes with the note.
    setDirty(false);
    void reloadKeepingPages(draft).catch((err: unknown) => {
      reload.disabled = false;
      setDirty(draft !== null);
      setStatus(`Couldn’t reload: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  });
}

/** Dev: the unsaved text this playlist had before Reload Wtv. */
async function restoreDraft(): Promise<void> {
  if (!DEV_TOOLS) return;
  const draft = await takePlaylistDraft(currentId);
  if (!draft) return;
  nameInput.value = draft.name;
  textInput.value = draft.text;
  renderPreview();
  setDirty(true);
  setStatus('Your unsaved changes from before the reload.');
}

void library
  .load()
  .then(async () => {
    overrides = await loadOverrideStore(local).catch(() => ({}));
  })
  .then(refresh)
  .then(renderEditor)
  .then(restoreDraft);
