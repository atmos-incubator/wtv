/**
 * Media library records: what Wtv learned about a URL as it played in a playlist (title,
 * creator, duration, thumbnail, whether it's gone). Pure; storage is db.ts, updates come
 * from the runner (service.ts).
 *
 * Keyed by the entry URL, normalized with `sameEntryUrl`'s rules so the spellings of one
 * video share a record: host without www. / m., path without a trailing slash, query
 * parameters sorted, the hash dropped. Start-time and share-tracking parameters
 * (`t`, `start`, `si`, `pp`, `feature`, `utm_*`) are dropped too: `t=1:00` of a video is
 * still that video.
 */
import { findSite } from '../sites/match';
import type { SiteConfig } from '../sites/schema';
import { originPatternForHost } from '../permissions';

export const MEDIA_STATUSES = ['ok', 'gone'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export interface MediaRecord {
  key: string;
  /** The entry URL it was last played from. */
  url: string;
  title: string | null;
  creator: string | null;
  /** The media's own duration, seconds; null unknown (or live). */
  durationS: number | null;
  live: boolean;
  thumbnailUrl: string | null;
  /** The cached thumbnail is of this URL (null: none cached). */
  thumbnailCachedFrom: string | null;
  status: MediaStatus;
  lastPlayedAt: number | null;
  /** The volume (0–1) last set with Wtv's ↑ / ↓ while it played; applied when it plays again. Null: the site's own. */
  volume: number | null;
  updatedAt: number;
}

/** What a page reports (any field may be missing), or the runner observes. */
export interface MediaPatch {
  url: string;
  title?: string | null;
  creator?: string | null;
  durationS?: number | null;
  live?: boolean;
  thumbnailUrl?: string | null;
  thumbnailCachedFrom?: string | null;
  status?: MediaStatus;
  lastPlayedAt?: number;
  volume?: number | null;
}

const DROP_PARAMS = new Set(['t', 'start', 'si', 'pp', 'feature']);
const MAX_TEXT = 300;
const MAX_URL = 2000;

export function libraryKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  const params = [...u.searchParams]
    .filter(([k]) => !DROP_PARAMS.has(k.toLowerCase()) && !/^utm_/i.test(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = new URLSearchParams(params).toString();
  return `${host}${path}${query ? `?${query}` : ''}`;
}

const text = (v: string | null | undefined): string | null => {
  const t = v?.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return t ? t : null;
};

const httpUrl = (v: string | null | undefined): string | null =>
  typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= MAX_URL ? v : null;

const seconds = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v * 10) / 10 : null;

/** A volume 0–1 (to two places), or null. */
export function volumeLevel(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 100) / 100 : null;
}

/**
 * Apply a patch. Missing fields keep what's known; a page that couldn't find a title
 * (null) doesn't erase one found before. A new thumbnail URL keeps the cached picture until
 * it's replaced (the old one is still better than none).
 */
export function mergeRecord(old: MediaRecord | null, patch: MediaPatch, now: number): MediaRecord | null {
  const key = libraryKey(patch.url);
  if (!key) return null;
  const base: MediaRecord = old ?? {
    key,
    url: patch.url,
    title: null,
    creator: null,
    durationS: null,
    live: false,
    thumbnailUrl: null,
    thumbnailCachedFrom: null,
    status: 'ok',
    lastPlayedAt: null,
    volume: null,
    updatedAt: now,
  };
  const live = patch.live ?? base.live;
  return {
    ...base,
    key,
    url: patch.url,
    title: text(patch.title) ?? base.title,
    creator: text(patch.creator) ?? base.creator,
    durationS: live ? null : (seconds(patch.durationS) ?? base.durationS),
    live,
    thumbnailUrl: httpUrl(patch.thumbnailUrl) ?? base.thumbnailUrl,
    thumbnailCachedFrom: patch.thumbnailCachedFrom !== undefined ? patch.thumbnailCachedFrom : base.thumbnailCachedFrom,
    status: patch.status ?? base.status,
    lastPlayedAt: patch.lastPlayedAt ?? base.lastPlayedAt,
    volume: patch.volume !== undefined ? volumeLevel(patch.volume) : (base.volume ?? null),
    updatedAt: now,
  };
}

/** The thumbnail needs (re)fetching. */
export function thumbnailStale(r: MediaRecord): boolean {
  return r.thumbnailUrl !== null && r.thumbnailCachedFrom !== r.thumbnailUrl;
}

export function parseRecord(raw: unknown): MediaRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<MediaRecord>;
  if (typeof r.key !== 'string' || typeof r.url !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    key: r.key,
    url: r.url,
    title: str(r.title),
    creator: str(r.creator),
    durationS: seconds(r.durationS),
    live: r.live === true,
    thumbnailUrl: httpUrl(r.thumbnailUrl),
    thumbnailCachedFrom: str(r.thumbnailCachedFrom),
    status: r.status === 'gone' ? 'gone' : 'ok',
    lastPlayedAt: typeof r.lastPlayedAt === 'number' ? r.lastPlayedAt : null,
    volume: volumeLevel(r.volume),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

// --- lengths -------------------------------------------------------------------------

export interface TimedEntry {
  startS: number | null;
  endS: number | null;
}

/**
 * How long an entry plays, seconds: from its start (or 0) to its end time or the media's
 * end, whichever is first. Known without the library when the entry has an end time.
 * Null: unknown (never played, or live with no end time).
 */
export function entryLengthS(entry: TimedEntry, durationS: number | null): number | null {
  const start = entry.startS ?? 0;
  const ends = [entry.endS, durationS].filter((v): v is number => v !== null);
  if (ends.length === 0) return null;
  return Math.max(0, Math.min(...ends) - start);
}

export interface PlaylistLength {
  totalS: number;
  unknown: number;
}

export function playlistLength(lengths: readonly (number | null)[]): PlaylistLength {
  let totalS = 0;
  let unknown = 0;
  for (const l of lengths) {
    if (l === null) unknown++;
    else totalS += l;
  }
  return { totalS, unknown };
}

/** "4:13", "1:02:03". */
export function formatClock(s: number): string {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** "about 2 h 10 min, 3 entries unknown". */
export function describeLength({ totalS, unknown }: PlaylistLength, entries: number): string {
  if (entries === 0) return '';
  const unknownText = `${unknown} entr${unknown === 1 ? 'y' : 'ies'} unknown`;
  if (unknown === entries) return 'Length unknown until the entries have played';
  const minutes = Math.round(totalS / 60);
  let length: string;
  if (totalS < 60) length = 'under a minute';
  else if (minutes < 60) length = `about ${minutes} min`;
  else {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    length = `about ${h} h${m ? ` ${m} min` : ''}`;
  }
  return unknown > 0 ? `${length}, ${unknownText}` : length;
}

// --- covers ---------------------------------------------------------------------------

/**
 * A playlist's cover pictures: the records of its entries that have a thumbnail, one per
 * video, most recently played first (never-played ones after, in playlist order).
 */
export function coverRecords(urls: readonly string[], records: ReadonlyMap<string, MediaRecord>): MediaRecord[] {
  const seen = new Set<string>();
  const out: { r: MediaRecord; order: number }[] = [];
  urls.forEach((url, order) => {
    const key = libraryKey(url);
    const r = key ? records.get(key) : undefined;
    if (!r || !r.thumbnailUrl || seen.has(r.key)) return;
    seen.add(r.key);
    out.push({ r, order });
  });
  return out
    .sort((a, b) => (b.r.lastPlayedAt ?? -1) - (a.r.lastPlayedAt ?? -1) || a.order - b.order)
    .map(({ r }) => r);
}

export interface CoverSlot {
  key: string;
  /** The entry's title, else the library's, else the host. */
  title: string;
  record: MediaRecord | null;
}

/**
 * Every video of a playlist once, for the explorer's cover: those with a thumbnail first
 * (coverRecords' order), then the rest in playlist order.
 */
export function coverSlots(
  entries: readonly { url: string; title: string | null }[],
  records: ReadonlyMap<string, MediaRecord>,
): CoverSlot[] {
  const titles = new Map<string, string>();
  const rest: CoverSlot[] = [];
  for (const e of entries) {
    const key = libraryKey(e.url) ?? e.url;
    if (titles.has(key)) continue;
    const record = records.get(key) ?? null;
    let host = e.url;
    try {
      host = new URL(e.url).hostname.replace(/^www\./, '');
    } catch {
      // Shown as-is.
    }
    const title = e.title ?? record?.title ?? host;
    titles.set(key, title);
    if (!record?.thumbnailUrl) rest.push({ key, title, record });
  }
  const pictured = coverRecords(
    entries.map((e) => e.url),
    records,
  ).map((r) => ({ key: r.key, title: titles.get(r.key) ?? r.title ?? r.url, record: r }));
  return [...pictured, ...rest];
}

// --- thumbnail hosts -----------------------------------------------------------------

/** Permission patterns for the thumbnail hosts of the sites these URLs are on. */
export function thumbnailOriginsFor(urls: readonly string[], sites: readonly SiteConfig[]): string[] {
  const out = new Set<string>();
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    for (const h of findSite(host, sites)?.thumbnailHosts ?? []) out.add(originPatternForHost(h));
  }
  return [...out].sort();
}

/** Every bundled thumbnail host's permission pattern: these never get content scripts. */
export function allThumbnailOrigins(sites: readonly SiteConfig[]): Set<string> {
  return new Set(sites.flatMap((s) => (s.thumbnailHosts ?? []).map(originPatternForHost)));
}
