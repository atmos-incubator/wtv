/**
 * When to cover a paused show with pictures (setting `pausePictures`). Pure.
 *
 * Only a real pause counts: the video has played (it isn't still loading), it isn't
 * buffering (that doesn't set `paused`), seeking or at its end, and it's been paused for
 * a moment, so a quick pause / play doesn't flash. Hover previews and clips (not a show)
 * never get pictures, and ads have their own.
 */

export const PAUSE_PICTURES_DELAY_MS = 1500;

export interface PauseFacts {
  enabled: boolean;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  /** HTMLMediaElement.readyState. */
  readyState: number;
  currentTime: number;
  /** Since the last `pause` event, or null if it's played since (or never paused). */
  pausedForMs: number | null;
  isShow: boolean;
  adActive: boolean;
}

const HAVE_CURRENT_DATA = 2;

export function pausePicturesDue(f: PauseFacts): boolean {
  if (!f.enabled || f.adActive || !f.isShow) return false;
  if (!f.paused || f.ended || f.seeking) return false;
  if (f.readyState < HAVE_CURRENT_DATA || f.currentTime <= 0) return false;
  return f.pausedForMs !== null && f.pausedForMs >= PAUSE_PICTURES_DELAY_MS;
}
