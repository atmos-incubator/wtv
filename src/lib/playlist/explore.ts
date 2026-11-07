/**
 * Playlist explorer (the side panel's Playlists view), pure parts: search, the order
 * playlists are listed in, and when each playlist was last played.
 *
 * Last played is recorded by the runner when a playlist starts (`KEYS.playlistPlays`,
 * local), for built-ins and yours alike. It isn't part of a backup.
 */

/** Ids kept in the last-played map; the oldest go first. */
export const MAX_PLAYS = 500;

/** Playlist id → when it last started playing (ms). */
export type PlaylistPlays = Record<string, number>;

export function parsePlays(raw: unknown): PlaylistPlays {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: PlaylistPlays = {};
  for (const [id, at] of Object.entries(raw)) {
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) out[id] = at;
  }
  return out;
}

export function withPlay(plays: PlaylistPlays, id: string, now: number): PlaylistPlays {
  const next = { ...plays, [id]: now };
  const ids = Object.keys(next);
  if (ids.length <= MAX_PLAYS) return next;
  const keep = ids.sort((a, b) => next[b]! - next[a]!).slice(0, MAX_PLAYS);
  return Object.fromEntries(keep.map((k) => [k, next[k]!]));
}

// --- search ---------------------------------------------------------------------------

/** Lowercase, without accents: "Café" finds "cafe". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

export interface SearchMatch {
  /** The playlist's name has every term: the whole playlist matches. */
  nameMatch: boolean;
  /** Otherwise, the entries that match (by index), their title and the name together having every term. */
  entries: number[];
}

/**
 * Does a playlist match? Every term must be in its name, or in one entry's title (terms
 * can be split between the two: "cats sleeping" finds "Sleeping" in "Cats"). No terms:
 * everything matches. Null: no match.
 */
export function matchPlaylist(name: string, titles: readonly (string | null)[], terms: readonly string[]): SearchMatch | null {
  if (terms.length === 0) return { nameMatch: true, entries: [] };
  const folded = fold(name);
  if (terms.every((t) => folded.includes(t))) return { nameMatch: true, entries: [] };
  const entries: number[] = [];
  titles.forEach((title, i) => {
    if (!title) return;
    const hay = `${folded} ${fold(title)}`;
    if (terms.every((t) => hay.includes(t))) entries.push(i);
  });
  return entries.length > 0 ? { nameMatch: false, entries } : null;
}

// --- order ----------------------------------------------------------------------------

export interface Explorable {
  id: string;
  name: string;
  builtin: boolean;
}

/** Most recently played first; then the never-played: yours, then built-ins, each by name. */
export function explorerOrder<T extends Explorable>(items: readonly T[], plays: PlaylistPlays): T[] {
  const rank = (p: T) => (p.id in plays ? 0 : p.builtin ? 2 : 1);
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || (plays[b.id] ?? 0) - (plays[a.id] ?? 0) || a.name.localeCompare(b.name),
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "3 weeks ago", "5 months ago". */
export function describeAgo(then: number, now: number): string {
  const ago = Math.max(0, now - then);
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  const days = Math.floor(ago / DAY);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}
