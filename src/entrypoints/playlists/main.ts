/**
 * Playlists page: list, edit (as text), play, export. The text is the playlist; the
 * entries column is a live preview of what it parses to.
 */
import './style.css';
import { browser } from 'wxt/browser';
import { browserAreas } from '../../lib/browser-storage';
import type { ProgramItem } from '../../lib/overlay/program';
import { compilePlaylist, parsePlaylist, type CompiledPlaylist } from '../../lib/playlist/format';
import { originPatternsFor } from '../../lib/playlist/match';
import { PL_COMMAND } from '../../lib/playlist/messages';
import { deletePlaylist, listPlaylists, savePlaylist, type StoredPlaylist } from '../../lib/playlist/store';
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

textInput.placeholder = 'Paste URLs here, one per line.\n\nhttps://www.youtube.com/watch?v=… | Title | t=1:37';

let playlists: StoredPlaylist[] = [];
let currentId: string | null = new URLSearchParams(location.search).get('id');
let dirty = false;
let compiled: CompiledPlaylist = compilePlaylist(parsePlaylist(''));

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

function formatTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

function describeProgram(label: string, items: ProgramItem[] | null, isDefault: boolean): string {
  if (!items) return `${label}: site pictures`;
  const quotes = items.filter((a) => a.kind === 'text').length;
  const imgs = items.length - quotes;
  const parts = [quotes && `${quotes} quote${quotes > 1 ? 's' : ''}`, imgs && `${imgs} picture set${imgs > 1 ? 's' : ''}`];
  return `${label}${isDefault ? ' (default)' : ''}: ${parts.filter(Boolean).join(', ')}`;
}

function countEntries(text: string): number {
  return compilePlaylist(parsePlaylist(text)).entries.length;
}

// --- rendering ---------------------------------------------------------------------

function renderList(): void {
  list.replaceChildren(
    ...playlists.map((p) => {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(p.id === currentId));
      const n = countEntries(p.text);
      b.append(el('span', '', p.name), el('span', 'count', `${n} entr${n === 1 ? 'y' : 'ies'}`));
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
  problemsList.replaceChildren(...compiled.problems.map((p) => el('li', '', `Line ${p.line}: ${p.message}`)));

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
        const meta = [host];
        if (e.startS !== null) meta.push(`from ${formatTime(e.startS)}`);
        if (e.view === 'pictures') {
          // The show's pictures fall back to the ads program; say which one it is.
          const label = e.show !== null && e.show === e.ads ? 'shown as pictures, from its ads' : 'shown as pictures';
          meta.push(describeProgram(label, e.show, e.show !== null && e.show === compiled.defaultShow));
        }
        meta.push(describeProgram('ads', e.ads, e.ads !== null && e.ads === compiled.defaultAds));
        const li = el('li');
        const play = el('button', '', '▶');
        play.type = 'button';
        play.title = 'Play from here';
        play.setAttribute('aria-label', `Play from entry ${i + 1}`);
        play.addEventListener('click', () => void playFrom(i));
        li.append(el('span', 'entry-title', e.title ?? e.url), play, el('span', 'entry-meta', meta.join(' · ')));
        return li;
      }),
    );
  }
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

async function playFrom(index: number): Promise<void> {
  const p = dirty ? await save() : current();
  if (!p) return;
  const { entries } = compilePlaylist(parsePlaylist(p.text));
  if (entries.length === 0) return;

  // Wtv only runs where it has host access: ask for every entry's site up front, in this
  // click, so the runner can detect each video's end.
  const origins = originPatternsFor(entries.map((e) => e.url));
  let granted = await browser.permissions.contains({ origins });
  if (!granted) granted = await browser.permissions.request({ origins }).catch(() => false);

  const result: unknown = await browser.runtime.sendMessage({
    type: PL_COMMAND,
    op: 'start',
    playlistId: p.id,
    index,
    tv: tvBox.checked,
  });
  const error = (result as { error?: unknown } | null)?.error;
  if (typeof error === 'string') setStatus(`Couldn’t start: ${error}`, true);
  else if (!granted) {
    setStatus('Playing. Without site access Wtv can’t tell when some videos end there; use Next (Alt+Shift+N).', true);
  } else setStatus(`Playing “${p.name}” in a new tab.`);
}

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

$('play').addEventListener('click', () => void playFrom(0));

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

void refresh().then(renderEditor);
