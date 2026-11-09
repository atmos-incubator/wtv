/**
 * The loading picture: which ad picture the playlist's loading screens show. Extension
 * pages only (the overlay iframe on each page, the card page): they share the extension
 * origin's localStorage.
 *
 * Moving to the next entry shows a loading screen on the page being left, then on the
 * new page (and for a post, on the card page): each a separate page that would pick its
 * own random picture, so one flashed in and was straight away replaced. Instead the
 * picture on screen is remembered with the move it's for (the runner's gen), and the
 * move's next loading screen carries on with it (while a slow page loads, the pictures
 * still change at their own pace). A new move (the next entry, Next / Previous) starts
 * with a different picture, whatever time the last one had left. STICKY_MS: older than
 * that, it's not this move's.
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

export interface LoadingPicture {
  slide: ImageSlide;
  /** It's this move's (and fresh): carry on with it. Otherwise it's the last move's: show another. */
  carry: boolean;
}

/** The remembered picture, for a loading screen of move `gen` at `now`. Pure. */
export function parseLoadingPicture(raw: string | null, now: number, gen: number | null): LoadingPicture | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const src = parseSource(v.src);
    if (!src || typeof v.at !== 'number') return null;
    const durationMs = typeof v.durationMs === 'number' && v.durationMs > 0 ? v.durationMs : 5000;
    const fresh = now - v.at <= STICKY_MS && now >= v.at - STICKY_MS;
    const sameMove = (typeof v.gen === 'number' ? v.gen : null) === gen;
    return { slide: { kind: 'img', src, isVideo: v.isVideo === true, durationMs }, carry: fresh && sameMove };
  } catch {
    return null;
  }
}

export function loadingPicture(gen: number | null): LoadingPicture | null {
  try {
    return parseLoadingPicture(localStorage.getItem(KEY), Date.now(), gen);
  } catch {
    return null;
  }
}

/** The picture move `gen`'s loading screen shows now (also "still showing it": keeps it fresh). */
export function rememberLoadingPicture(slide: ImageSlide, gen: number | null): void {
  try {
    const v = { src: slide.src, isVideo: slide.isVideo, durationMs: slide.durationMs, at: Date.now(), gen };
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // Storage off: each screen picks its own.
  }
}

/**
 * `slides` for move `gen`'s loading screen: this move's picture first (`carried`), or,
 * for a new move, the last move's picture moved to the back. Pure.
 */
export function orderLoadingSlides<S extends Slide>(slides: readonly S[], last: LoadingPicture | null): { slides: (S | ImageSlide)[]; carried: boolean } {
  if (!last) return { slides: [...slides], carried: false };
  const isLast = (s: Slide) => s.kind === 'img' && sameSource(s.src, last.slide.src);
  if (last.carry) return { slides: [last.slide, ...slides.filter((s) => !isLast(s))], carried: true };
  return { slides: [...slides.filter((s) => !isLast(s)), ...slides.filter(isLast)], carried: false };
}

export const sameSource = (a: ImageSource, b: ImageSource) =>
  a.type === b.type && (a.type === 'library' ? a.id === (b as { id: string }).id : a.url === (b as { url: string }).url);
