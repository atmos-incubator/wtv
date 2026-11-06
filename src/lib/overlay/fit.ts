/**
 * How a picture fills the overlay. Pure.
 *
 * `cover` fills the frame but crops; `contain` shows everything with letterbox bars.
 * Prefer cover when it would crop less than `maxCrop` of the picture, else contain.
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
