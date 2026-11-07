/** The built-in playlists shipped in src/playlists/ (see builtin.ts). */
import { loadBuiltinPlaylists, type BuiltinPlaylist } from './builtin';

const texts = import.meta.glob<string>('../../playlists/*.txt', { eager: true, query: '?raw', import: 'default' });
const covers = import.meta.glob<string>('../../playlists/*.svg', { eager: true, query: '?url', import: 'default' });

const result = loadBuiltinPlaylists(texts, covers);
for (const e of result.errors) console.error('[wtv] built-in playlist:', e);

/** Valid built-ins with entries, sorted by name. */
export const BUILTIN_PLAYLISTS: readonly BuiltinPlaylist[] = result.playlists;

export function getBuiltinPlaylist(id: string): BuiltinPlaylist | null {
  return BUILTIN_PLAYLISTS.find((p) => p.id === id) ?? null;
}

/** Exposed for tests. */
export const BUILTIN_LOAD_RESULT = result;
