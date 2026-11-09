/**
 * The loading picture: which ad picture the playlist's loading screens show. Extension
 * pages only (the overlay iframe on each page, the card page): they share the extension
 * origin's localStorage.
 *
 * Moving to the next entry shows a loading screen on the page being left, then on the
 * new page (and for a post, on the card page): each a separate page that would pick its
 * own random picture, so one flashed in and was straight away replaced. Instead the
 * picture on screen is remembered, and a loading screen within STICKY_MS of the last one
 * carries on with it. After a while (the entry played) the next one picks afresh.
 */
import type { ImageSource, Slide } from '../overlay/program';

type ImageSlide = Extract<Slide, { kind: 'img' }>;

const KEY = 'wtv.loadingPicture';
/** A loading screen this soon after the last one shows the same picture. */
export const STICKY_MS = 30_000;

function parseSource(raw: unknown): ImageSource | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (s.type === 'library' && typeof s.id === 'string') return { type: 'library', id: s.id };
  if (s.type === 'url' && typeof s.url === 'string') return { type: 'url', url: s.url };
  return null;
}

/** The remembered picture if it's still fresh at `now`. Pure. */
export function parseLoadingPicture(raw: string | null, now: number): ImageSlide | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const src = parseSource(v.src);
    if (!src || typeof v.at !== 'number' || now - v.at > STICKY_MS || now < v.at - STICKY_MS) return null;
    const durationMs = typeof v.durationMs === 'number' && v.durationMs > 0 ? v.durationMs : 5000;
    return { kind: 'img', src, isVideo: v.isVideo === true, durationMs };
  } catch {
    return null;
  }
}

export function loadingPicture(): ImageSlide | null {
  try {
    return parseLoadingPicture(localStorage.getItem(KEY), Date.now());
  } catch {
    return null;
  }
}

/** The picture a loading screen shows now (also "still showing it": keeps it fresh). */
export function rememberLoadingPicture(slide: ImageSlide): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ src: slide.src, isVideo: slide.isVideo, durationMs: slide.durationMs, at: Date.now() }));
  } catch {
    // Storage off: each screen picks its own.
  }
}

export const sameSource = (a: ImageSource, b: ImageSource) =>
  a.type === b.type && (a.type === 'library' ? a.id === (b as { id: string }).id : a.url === (b as { url: string }).url);
