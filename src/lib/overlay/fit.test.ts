import { describe, expect, it } from 'vitest';
import { coverCropFraction, fitMode } from './fit';

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
