import { describe, expect, it } from 'vitest';
import { MAX_PAN_FRAMES_PER_S, coverCropFraction, fitMode, pans, placePicture } from './fit';

describe('coverCropFraction', () => {
  it('is zero for matching aspect ratios', () => {
    expect(coverCropFraction(1920, 1080, 1280, 720)).toBeCloseTo(0);
  });

  it('measures the cropped share either way round', () => {
    // 4:3 picture in a 16:9 frame: cover keeps 75% of the height.
    expect(coverCropFraction(1600, 1200, 1600, 900)).toBeCloseTo(0.25);
    // 16:9 picture in a 4:3 frame: same crop, sideways.
    expect(coverCropFraction(1600, 900, 1600, 1200)).toBeCloseTo(0.25);
  });
});

describe('fitMode', () => {
  it('covers when the crop is small', () => {
    // 16:10 picture in a 16:9 frame crops 10%.
    expect(fitMode(1920, 1200, 1920, 1080)).toBe('cover');
  });

  it('letterboxes when the crop would be large', () => {
    expect(fitMode(1600, 1200, 1600, 900)).toBe('contain'); // 25%
    expect(fitMode(1080, 1920, 1920, 1080)).toBe('contain'); // portrait in landscape
  });

  it('letterboxes at exactly the threshold', () => {
    // 1.6 → 2.0 aspect: 1 - 1.6/2 = 0.2
    expect(fitMode(1600, 1000, 2000, 1000)).toBe('contain');
  });

  it('falls back to contain without dimensions', () => {
    expect(fitMode(0, 0, 1920, 1080)).toBe('contain');
    expect(fitMode(1920, 1080, 0, 0)).toBe('contain');
  });
});

describe('placePicture', () => {
  it('fills the frame and pans across what cover crops', () => {
    // 16:10 in 16:9: 1920×1200 at scale 1, 120 px too tall.
    const p = placePicture(1920, 1200, 1920, 1080, 5000);
    expect(p.width).toBeCloseTo(1920);
    expect(p.height).toBeCloseTo(1200);
    expect(p.from).toEqual({ x: 0, y: 0 });
    expect(p.to.x).toBeCloseTo(0);
    expect(p.to.y).toBeCloseTo(-120);
    expect(pans(p)).toBe(true);
  });

  it('does not pan a picture that fits the frame exactly', () => {
    const p = placePicture(1280, 720, 1920, 1080, 5000);
    expect(pans(p)).toBe(false);
    expect(p.width).toBeCloseTo(1920);
  });

  it('letterboxes a small picture of another shape', () => {
    const p = placePicture(400, 800, 1600, 900, 5000);
    expect(pans(p)).toBe(false);
    expect(p.height).toBeCloseTo(900);
    expect(p.from.x).toBeCloseTo((1600 - 450) / 2);
  });

  it('pans a big picture of another shape the long way, at its own size at most', () => {
    // A 4:3 photo, bigger than the frame: crop 25%, so not cover. Fills the width, pans down.
    const photo = placePicture(4000, 3000, 1600, 900, 5000);
    expect(photo.width).toBeCloseTo(1600);
    expect(photo.height).toBeCloseTo(1200);
    expect(photo.to.y).toBeCloseTo(-300);
    // A panorama: as tall as the frame (scale 0.9), but no faster than the cap allows.
    const pano = placePicture(6000, 1000, 1600, 900, 5000);
    const most = 1600 * (1 + MAX_PAN_FRAMES_PER_S * 5);
    expect(pano.width).toBeCloseTo(most);
    expect(pano.to.x).toBeCloseTo(1600 - most);
    expect(pano.from.y).toBeCloseTo((900 - pano.height) / 2);
    // Given longer, it's shown larger (up to filling the frame's height).
    expect(placePicture(6000, 1000, 1600, 900, 60_000).height).toBeCloseTo(900);
  });

  it('never shows a picture smaller than whole', () => {
    const strip = placePicture(500, 20_000, 1600, 900, 1000);
    expect(strip.height).toBeGreaterThanOrEqual(900 - 0.01);
  });
});
