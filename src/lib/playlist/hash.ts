/**
 * The `#wtv:` hash. Pure.
 *
 *   https://www.youtube.com/watch?v=abc#wtv:t=97&e=187&d=Some%20Title
 *
 *   t   start time (any parseTimestamp format; written as seconds)
 *   e   end time, same format: the media pauses there (in a playlist, the next entry starts)
 *   d   display title for the blackout (encodeURIComponent, so underscores etc. survive)
 *   v   `read` or `scroll`: the page is the show (page-show/), so don't wait for a video
 *
 * Namespaced so it can't collide with a site's own hash routing or `t` parameter. The
 * background runner's state is the source of truth for playlists; the hash is the
 * synchronous fast path that lets the top frame black out at document_start, before
 * the background has answered (and before the page paints). It also works on its own:
 * a link with `#wtv:t=…` opens like a TV channel (blackout, start, seek, stop at the end).
 *
 * The content script removes it from the address bar once read, so it's one-shot: a
 * reload or a copied URL is the plain page.
 */
import { parseTimestamp } from './time';

export const HASH_PREFIX = '#wtv:';
const MAX_TITLE = 500;

export interface WtvHash {
  /** Seconds. */
  t: number | null;
  /** Seconds. */
  end: number | null;
  title: string | null;
  /** A page shown as a page (`read` / `scroll`); null: the usual (media). */
  view?: HashView | null;
}

export type HashView = 'read' | 'scroll';

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `location.hash` → params, or null if it isn't a Wtv hash. */
export function parseWtvHash(hash: string): WtvHash | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const out: WtvHash = { t: null, end: null, title: null, view: null };
  for (const part of hash.slice(HASH_PREFIX.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = decode(part.slice(eq + 1));
    if (key === 't') out.t = parseTimestamp(value);
    else if (key === 'e') out.end = parseTimestamp(value);
    else if (key === 'd') out.title = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || null;
    else if (key === 'v' && (value === 'read' || value === 'scroll')) out.view = value;
  }
  return out;
}

const seconds = (s: number | null): string | null =>
  s !== null && Number.isFinite(s) && s > 0 ? String(Number(s.toFixed(3))) : null;

export function formatWtvHash(params: WtvHash): string {
  const parts: string[] = [];
  const t = seconds(params.t);
  const end = seconds(params.end);
  if (t) parts.push(`t=${t}`);
  if (end) parts.push(`e=${end}`);
  if (params.title) parts.push(`d=${encodeURIComponent(params.title)}`);
  if (params.view) parts.push(`v=${params.view}`);
  return HASH_PREFIX + parts.join('&');
}

/**
 * The URL to navigate to for an entry. Entries with a hash of their own (hash-routed
 * sites) are left alone: replacing it would break the site; the runner's hello still
 * covers them, just without the instant blackout.
 */
export function withWtvHash(url: string, params: WtvHash): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.hash && !u.hash.startsWith(HASH_PREFIX)) return url;
  u.hash = formatWtvHash(params).slice(1);
  return u.toString();
}

/** The URL without a Wtv hash (other hashes are kept). */
export function stripWtvHash(url: string): string {
  const i = url.indexOf(HASH_PREFIX);
  return i >= 0 ? url.slice(0, i) : url;
}
