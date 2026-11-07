/**
 * When to seek to an entry's start time. Pure.
 *
 * Only once the media knows its duration (`loadedmetadata`), and never during an ad.
 * On sites whose ads play in the main <video> (`quirks.adsInMainVideo`, YouTube), the
 * element's first metadata may be the pre-roll's, and ad detection can lag the ad's
 * first frames, so there the seek also waits until the content has been playing for a
 * moment with no ad showing. Elsewhere it seeks as soon as metadata arrives, before the
 * first frame, so there's no visible jump.
 *
 * And when an entry is over (`endState`): at its `end=` / `dur=` time, or the media's
 * own end. Both are measured in the media's own time, so ads never count.
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

/** Report near-end this close to the end (YouTube's end screen starts ~20 s out). */
export const NEAR_END_S = 20;
/** Treat playback this close to the end as ended (some players stop just short). */
export const END_SLACK_S = 0.25;
/** Shorter media isn't the show (and has no meaningful near-end). */
export const MIN_SHOW_S = 30;

export interface EndInput {
  currentTime: number;
  /** Seconds; NaN unknown, Infinity live. */
  duration: number;
  /** The entry's end time, or null. */
  endS: number | null;
  /** The start-time seek is settled: before that, currentTime may be where the site resumed. */
  seekDone: boolean;
}

/**
 * `end-time`: the entry's end time is reached (pause there). `ended`: the media is at its
 * own end. `near-end`: close to whichever end applies. Call outside ads only.
 */
export type EndState = 'end-time' | 'ended' | 'near-end' | null;

export function endState(s: EndInput): EndState {
  const d = s.duration;
  if (!Number.isFinite(d) || d < 1) return null;
  const endS = s.endS !== null && s.seekDone && s.endS < d ? s.endS : null;
  if (endS !== null && s.currentTime >= endS) return 'end-time';
  const left = (endS ?? d) - s.currentTime;
  if (endS === null && s.currentTime > 0 && left <= END_SLACK_S) return 'ended';
  if (d >= MIN_SHOW_S && left <= NEAR_END_S) return 'near-end';
  return null;
}

export function seekDecision(s: SeekInput): SeekDecision {
  // 0 still counts: an entry with an end time starts from the top, even if the site
  // would resume where the viewer left off.
  if (!(s.startS >= 0)) return 'skip';
  if (s.adActive || s.readyState < HAVE_METADATA) return 'wait';
  // Live streams: a start time means nothing.
  if (s.duration === Infinity) return 'skip';
  if (!Number.isFinite(s.duration)) return 'wait';
  if (s.adsInMainVideo && s.playingForMs < AD_SETTLE_MS) return 'wait';
  if (s.startS >= s.duration) return 'skip';
  if (Math.abs(s.currentTime - s.startS) <= SEEK_TOLERANCE_S) return 'skip';
  return 'seek';
}
