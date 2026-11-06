/**
 * Click-shield geometry and eligibility. Pure.
 *
 * In normal playback the shield covers the video but leaves the site's control bar at
 * the bottom uncovered (`quirks.controlBarInset`, or a generic default that clears most
 * players' bars). During ads and while maximized it covers everything.
 */
import type { CandidateFeatures } from '../media/score';

/** Most custom players' control bars fit in this. */
export const DEFAULT_CONTROL_INSET = 56;
/** Below this the shield isn't worth having (and would hide small players entirely). */
export const MIN_SHIELD_HEIGHT = 60;
/** Generic sites: only shield something that looks like a show, not a clip. */
export const MIN_SHOW_SECONDS = 30;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The video box minus the control-bar strip, or null if too little would remain. */
export function shieldRect(video: Box, insetPx: number): Box | null {
  const height = video.height - Math.max(0, insetPx);
  if (video.width <= 0 || height < MIN_SHIELD_HEIGHT) return null;
  return { left: video.left, top: video.top, width: video.width, height };
}

/**
 * Whether the primary deserves a shield in normal playback. Hover previews and GIF-style
 * loops (muted, looping, short) must stay clickable: on many sites clicking them is how
 * you open the video. A site config's `video` match is trusted as-is.
 */
export function isShow(f: CandidateFeatures): boolean {
  if (!f.isVideo || !f.hasSource) return false;
  if (f.configMatch) return true;
  if (!f.audible || f.loop) return false;
  return f.duration === Infinity || f.duration >= MIN_SHOW_SECONDS;
}
