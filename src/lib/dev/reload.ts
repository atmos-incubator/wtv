/**
 * Dev builds: reload Wtv (picks up a new build from disk) without losing your place.
 *
 * Reloading an extension closes every tab showing one of its pages. So first the open
 * pages are written down (storage.local: `storage.session` is cleared by the reload),
 * with the playlists page's unsaved text; the new background opens them again where
 * they were, and the playlists page takes its draft back. Playlist tabs on the card page
 * aren't reopened: the playlist itself stopped with the reload.
 */
import { browser } from 'wxt/browser';
import { browserAreas } from '../browser-storage';

const REOPEN_KEY = 'wtv.dev.reopen';
const DRAFT_KEY = 'wtv.dev.playlistDraft';
/** Older than this, the note is from some other time: ignored. */
const FRESH_MS = 60_000;
/** Pages worth reopening (the others belong to a playlist or a site). */
const PAGES = ['/playlists.html', '/options.html'];

export interface ReopenTab {
  url: string;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
}

export interface PlaylistDraft {
  id: string;
  name: string;
  text: string;
}

interface Note {
  at: number;
  tabs: ReopenTab[];
  draft: PlaylistDraft | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The extension's own pages among `tabs`, worth reopening. Pure. */
export function pagesToReopen(
  tabs: readonly { url?: string; windowId?: number; index?: number; active?: boolean; pinned?: boolean }[],
  base: string,
): ReopenTab[] {
  const out: ReopenTab[] = [];
  for (const t of tabs) {
    if (!t.url?.startsWith(base) || t.windowId === undefined) continue;
    const path = new URL(t.url).pathname;
    if (!PAGES.includes(path)) continue;
    out.push({ url: t.url, windowId: t.windowId, index: t.index ?? -1, active: t.active === true, pinned: t.pinned === true });
  }
  return out;
}

function parseDraft(raw: unknown): PlaylistDraft | null {
  if (!isObj(raw)) return null;
  const { id, name, text } = raw;
  return typeof id === 'string' && typeof name === 'string' && typeof text === 'string' ? { id, name, text } : null;
}

/** The note, if it's fresh at `now`. Pure. */
export function parseNote(raw: unknown, now: number, base: string): Note | null {
  if (!isObj(raw) || typeof raw.at !== 'number' || now - raw.at > FRESH_MS || raw.at > now + FRESH_MS) return null;
  const tabs = Array.isArray(raw.tabs) ? pagesToReopen(raw.tabs as ReopenTab[], base) : [];
  return { at: raw.at, tabs, draft: parseDraft(raw.draft) };
}

/**
 * Our pages open in tabs, from their own windows: tabs.query only gives URLs with the
 * `tabs` permission, which Wtv doesn't ask for.
 */
async function openPages(): Promise<{ url: string; windowId?: number; index?: number; active?: boolean; pinned?: boolean }[]> {
  const out = [];
  for (const raw of browser.extension.getViews({ type: 'tab' })) {
    const view = raw as unknown as { location: Location; chrome?: typeof browser };
    const tab = await view.chrome?.tabs.getCurrent().catch(() => undefined);
    if (tab) out.push({ ...tab, url: view.location.href });
  }
  return out;
}

/** Extension page: note the open pages (and `draft`, this page's unsaved text), then reload. */
export async function reloadKeepingPages(draft: PlaylistDraft | null): Promise<void> {
  const base = browser.runtime.getURL('/');
  const tabs = pagesToReopen(await openPages(), base);
  const note: Note = { at: Date.now(), tabs, draft };
  await browserAreas().local.set({ [REOPEN_KEY]: note });
  browser.runtime.reload();
}

/** Background, at startup: open the noted pages again. */
export async function reopenNotedPages(): Promise<void> {
  const local = browserAreas().local;
  const raw = (await local.get(REOPEN_KEY))[REOPEN_KEY];
  if (raw === undefined) return;
  await local.remove(REOPEN_KEY);
  const note = parseNote(raw, Date.now(), browser.runtime.getURL('/'));
  if (!note) return;
  if (note.draft) await local.set({ [DRAFT_KEY]: { ...note.draft, at: Date.now() } });
  // Left to right, so the indexes come out as they were.
  for (const t of [...note.tabs].sort((a, b) => a.index - b.index)) {
    const where = { url: t.url, active: t.active, pinned: t.pinned };
    await browser.tabs
      .create({ ...where, windowId: t.windowId, index: t.index >= 0 ? t.index : undefined })
      // The window went away meanwhile: anywhere.
      .catch(() => browser.tabs.create(where))
      .catch((err: unknown) => console.warn('[wtv] couldn’t reopen', t.url, err));
  }
  console.info(`[wtv] reloaded; reopened ${note.tabs.length} page(s)`);
}

/** Playlists page, at load: the unsaved text playlist `id` had before the reload (once). */
export async function takePlaylistDraft(id: string | null): Promise<PlaylistDraft | null> {
  const local = browserAreas().local;
  const raw = (await local.get(DRAFT_KEY))[DRAFT_KEY];
  if (raw === undefined) return null;
  if (!isObj(raw) || typeof raw.at !== 'number' || Date.now() - raw.at > FRESH_MS) {
    await local.remove(DRAFT_KEY);
    return null;
  }
  const draft = parseDraft(raw);
  if (!draft || draft.id !== id) return null; // Another playlists tab's.
  await local.remove(DRAFT_KEY);
  return draft;
}
