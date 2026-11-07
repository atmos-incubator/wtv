/**
 * Saved playlists in chrome.storage.local, stored as their text (the text is the source
 * of truth, so comments and layout survive). Works on any KVArea, so it's unit-tested
 * with an in-memory area.
 */
import { KEYS, type KVArea } from '../storage';
import { appendEntry, parsePlaylist, serializePlaylist } from './format';

export interface StoredPlaylist {
  id: string;
  name: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export type PlaylistStore = Record<string, StoredPlaylist>;

const MAX_NAME = 80;

export function isPlaylist(v: unknown, id: string): v is StoredPlaylist {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    p.id === id &&
    typeof p.name === 'string' &&
    typeof p.text === 'string' &&
    typeof p.createdAt === 'number' &&
    typeof p.updatedAt === 'number'
  );
}

export async function loadPlaylistStore(area: KVArea): Promise<PlaylistStore> {
  const raw = (await area.get(KEYS.playlists))[KEYS.playlists];
  const out: PlaylistStore = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) if (isPlaylist(p, id)) out[id] = p;
  return out;
}

export async function savePlaylistStore(area: KVArea, store: PlaylistStore): Promise<void> {
  await area.set({ [KEYS.playlists]: store });
}

export function newPlaylistId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `pl-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** "Playlist 3": the first free number. */
export function nextPlaylistName(existing: readonly { name: string }[]): string {
  const names = new Set(existing.map((p) => p.name));
  for (let n = 1; ; n++) if (!names.has(`Playlist ${n}`)) return `Playlist ${n}`;
}

/** Sorted by name. */
export async function listPlaylists(area: KVArea): Promise<StoredPlaylist[]> {
  return Object.values(await loadPlaylistStore(area)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPlaylist(area: KVArea, id: string): Promise<StoredPlaylist | null> {
  return (await loadPlaylistStore(area))[id] ?? null;
}

/** Create (no id) or update. An empty name gets "Playlist N". */
export async function savePlaylist(
  area: KVArea,
  input: { id?: string; name: string; text: string },
  now = Date.now(),
): Promise<StoredPlaylist> {
  const store = await loadPlaylistStore(area);
  const existing = input.id ? store[input.id] : undefined;
  const id = existing?.id ?? newPlaylistId();
  const others = Object.values(store).filter((p) => p.id !== id);
  const saved: StoredPlaylist = {
    id,
    name: cleanName(input.name) || nextPlaylistName(others),
    text: input.text,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store[id] = saved;
  await savePlaylistStore(area, store);
  return saved;
}

export async function deletePlaylist(area: KVArea, id: string): Promise<void> {
  const store = await loadPlaylistStore(area);
  if (!(id in store)) return;
  delete store[id];
  await savePlaylistStore(area, store);
}

/** Append a URL to a playlist (null id: a new playlist). Returns the playlist. */
export async function addToPlaylist(
  area: KVArea,
  id: string | null,
  url: string,
  title: string | null,
  now = Date.now(),
): Promise<StoredPlaylist> {
  const existing = id ? await getPlaylist(area, id) : null;
  if (id && !existing) throw new Error(`no playlist ${id}`);
  const text = serializePlaylist(appendEntry(parsePlaylist(existing?.text ?? ''), url, title));
  return savePlaylist(area, { id: existing?.id, name: existing?.name ?? '', text }, now);
}
