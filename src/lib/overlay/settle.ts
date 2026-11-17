/**
 * Settling: while a new video's page is still being built, everything but its player is
 * hidden (settler.ts), so the site's half-built UI, its suggestions, and a video caught
 * between sizes don't flash. Pure.
 *
 * Starts when the playlist's blackout lifts (any mode after it: the playlist is the TV
 * here), and when cover pictures (ads, pause / show pictures) come up soon after a new
 * video appeared (the primary media changing, an in-page navigation), or are up when one
 * does. Ends once the player has held still for a moment, the video can play and the page
 * has loaded, or after a cap either way.
 */

/** Cover pictures this soon after a new video appeared start settling. */
export const SETTLE_WINDOW_MS = 2000;
/** The player must hold still this long. */
export const SETTLE_STABLE_MS = 800;
/** Never keep the page hidden longer than this. */
export const SETTLE_MAX_MS = 5000;
/** The curtain fades out over this. */
export const CURTAIN_FADE_MS = 200;

const HAVE_FUTURE_DATA = 3;

export interface CurtainFacts {
  /** Since settling started (or was restarted). */
  upForMs: number;
  /** Since the player last moved, resized, or had no box. */
  stableForMs: number;
  /** The video can play (and the page has loaded). */
  ready: boolean;
}

/** Why the page can be shown now, or null to keep it hidden. */
export function curtainDone(f: CurtainFacts): 'settled' | 'timeout' | null {
  if (f.upForMs >= SETTLE_MAX_MS) return 'timeout';
  return f.ready && f.stableForMs >= SETTLE_STABLE_MS ? 'settled' : null;
}

/** A video that has enough data to play and isn't jumping somewhere. */
export function videoReady(v: Pick<HTMLMediaElement, 'readyState' | 'seeking'> | null): boolean {
  return v !== null && v.readyState >= HAVE_FUTURE_DATA && !v.seeking;
}

/** Whether a new video appeared recently enough that its page may still be laying out. */
export function recentlyUnsettled(unsettledAt: number | null, now: number): boolean {
  return unsettledAt !== null && now - unsettledAt < SETTLE_WINDOW_MS;
}
