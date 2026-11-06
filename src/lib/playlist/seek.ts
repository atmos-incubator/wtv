/**
 * When to seek to an entry's start time. Pure.
 *
 * Only once the media knows its duration (`loadedmetadata`), and never during an ad.
 * On sites whose ads play in the main <video> (`quirks.adsInMainVideo`, YouTube), the
 * element's first metadata may be the pre-roll's, and ad detection can lag the ad's
 * first frames, so there the seek also waits until the content has been playing for a
 * moment with no ad showing. Elsewhere it seeks as soon as metadata arrives, before the
 * first frame, so there's no visible jump.
 */

export interface SeekInput {
  startS: number;
  currentTime: number;
  /** Seconds; NaN unknown, Infinity live. */
  duration: number;
  /** HTMLMediaElement.readyState */
  readyState: number;
  adActive: boolean;
  adsInMainVideo: boolean;
  /** How long it's been playing without an ad, ms (0 if not playing). */
  playingForMs: number;
}

export type SeekDecision = 'seek' | 'wait' | 'skip';

/** Already this close to the start time (the site honoured its own parameter): leave it. */
export const SEEK_TOLERANCE_S = 1.5;
/** adsInMainVideo: content must have played this long, ad-free, before we trust it. */
export const AD_SETTLE_MS = 750;
const HAVE_METADATA = 1;

export function seekDecision(s: SeekInput): SeekDecision {
  if (!(s.startS > 0)) return 'skip';
  if (s.adActive || s.readyState < HAVE_METADATA) return 'wait';
  // Live streams: a start time means nothing.
  if (s.duration === Infinity) return 'skip';
  if (!Number.isFinite(s.duration)) return 'wait';
  if (s.adsInMainVideo && s.playingForMs < AD_SETTLE_MS) return 'wait';
  if (s.startS >= s.duration) return 'skip';
  if (Math.abs(s.currentTime - s.startS) <= SEEK_TOLERANCE_S) return 'skip';
  return 'seek';
}
