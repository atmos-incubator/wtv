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

/**
 * Strip at the bottom of the (normal-playback) shield, just above the site's progress
 * bar: a click there seeks instead of toggling playback.
 */
export const SEEK_BAND_PX = 24;

/** A click at fraction `y` (0 top … 1 bottom) of a shield `heightPx` tall lands in the band. */
export function inSeekBand(y: number, heightPx: number, bandPx: number): boolean {
  return bandPx > 0 && heightPx > 0 && (1 - y) * heightPx <= bandPx + 1e-6;
}

/** Where along a bar `clientX` falls, clamped to 0–1. */
export function seekFraction(clientX: number, bar: Pick<Box, 'left' | 'width'>): number {
  if (bar.width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - bar.left) / bar.width));
}

/**
 * Seconds to seek to. Finite media maps onto its duration; live streams onto their
 * seekable window (DVR). Null when there's nothing to seek within.
 */
export function seekTime(
  fraction: number,
  duration: number,
  seekable: { start: number; end: number } | null,
): number | null {
  if (Number.isFinite(duration) && duration > 0) return fraction * duration;
  if (seekable && seekable.end > seekable.start) return seekable.start + fraction * (seekable.end - seekable.start);
  return null;
}
