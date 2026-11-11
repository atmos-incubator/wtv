/**
 * How a picture fills the overlay. Pure.
 *
 * `cover` fills the frame but crops; `contain` shows everything with letterbox bars.
 * Prefer cover when it would crop less than `maxCrop` of the picture, else contain.
 *
 * `placePicture` adds panning: a picture that doesn't fit is moved across the frame over
 * the time it shows, so all of it is seen (see there).
 */

export type FitMode = 'cover' | 'contain';

/** Up to 20% of the picture may be cropped to avoid letterbox bars. */
export const MAX_COVER_CROP = 0.2;

/** Fraction of the picture `object-fit: cover` would crop away (0 = none). */
export function coverCropFraction(mediaW: number, mediaH: number, boxW: number, boxH: number): number {
  if (mediaW <= 0 || mediaH <= 0 || boxW <= 0 || boxH <= 0) return 0;
  const media = mediaW / mediaH;
  const box = boxW / boxH;
  return 1 - Math.min(media / box, box / media);
}

export function fitMode(
  mediaW: number,
  mediaH: number,
  boxW: number,
  boxH: number,
  maxCrop: number = MAX_COVER_CROP,
): FitMode {
  if (mediaW <= 0 || mediaH <= 0 || boxW <= 0 || boxH <= 0) return 'contain';
  // Epsilon so float noise right at the threshold doesn't flip the result.
  return coverCropFraction(mediaW, mediaH, boxW, boxH) < maxCrop - 1e-9 ? 'cover' : 'contain';
}

export interface Point {
  x: number;
  y: number;
}

/** Where a picture sits in the frame: its size, and its top-left at the slide's start and end. */
export interface Placement {
  width: number;
  height: number;
  from: Point;
  to: Point;
}

/** A pan moves at most this many frame lengths (the panned way) a second. */
export const MAX_PAN_FRAMES_PER_S = 0.3;

/**
 * Size and pan for a picture shown `durationMs` in a `boxW`×`boxH` frame:
 *
 *   - Close to the frame's shape (cover crops under `maxCrop`): it fills the frame, and pans
 *     across the cropped part, so nothing is lost.
 *   - Too big for the frame and a different shape (a panorama, a tall screenshot, a portrait
 *     photo on a landscape screen): it's shown as large as it is, up to filling the frame
 *     the short way, and pans the long way. Never faster than MAX_PAN_FRAMES_PER_S: a
 *     long one is shown smaller instead (but never smaller than whole).
 *   - Anything else: whole, centred, letterboxed (no pan).
 *
 * Pans run left → right, top → bottom; on the other axis it's centred.
 */
export function placePicture(
  mediaW: number,
  mediaH: number,
  boxW: number,
  boxH: number,
  durationMs: number,
  maxCrop: number = MAX_COVER_CROP,
): Placement {
  if (mediaW <= 0 || mediaH <= 0 || boxW <= 0 || boxH <= 0) {
    return { width: boxW, height: boxH, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
  }
  const contain = Math.min(boxW / mediaW, boxH / mediaH);
  const cover = Math.max(boxW / mediaW, boxH / mediaH);
  let scale: number;
  if (fitMode(mediaW, mediaH, boxW, boxH, maxCrop) === 'cover') {
    scale = cover;
  } else if (mediaW > boxW || mediaH > boxH) {
    scale = Math.max(contain, Math.min(cover, 1));
    // The long way, at most this much more than the frame in the time it shows.
    const seconds = Math.max(0, durationMs) / 1000;
    const wide = mediaW / mediaH > boxW / boxH;
    const room = (wide ? boxW : boxH) * (1 + MAX_PAN_FRAMES_PER_S * seconds);
    scale = Math.max(contain, Math.min(scale, room / (wide ? mediaW : mediaH)));
  } else {
    scale = contain;
  }
  const width = mediaW * scale;
  const height = mediaH * scale;
  // Centred where it fits; from one edge to the other where it doesn't.
  const span = (size: number, box: number): [number, number] => (size <= box + 0.5 ? [(box - size) / 2, (box - size) / 2] : [0, box - size]);
  const [x0, x1] = span(width, boxW);
  const [y0, y1] = span(height, boxH);
  return { width, height, from: { x: x0, y: y0 }, to: { x: x1, y: y1 } };
}

/** The placement moves. */
export function pans(p: Placement): boolean {
  return Math.abs(p.from.x - p.to.x) >= 1 || Math.abs(p.from.y - p.to.y) >= 1;
}
