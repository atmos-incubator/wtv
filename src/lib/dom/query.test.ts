import { describe, expect, it } from 'vitest';
import { visibleAreaOf } from './query';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('visibleAreaOf', () => {
  it('measures a fully visible rect', () => {
    expect(visibleAreaOf(rect(10, 10, 110, 60), 1000, 800)).toBe(100 * 50);
  });

  it('clips to the viewport', () => {
    expect(visibleAreaOf(rect(-50, -50, 50, 50), 1000, 800)).toBe(50 * 50);
    expect(visibleAreaOf(rect(950, 750, 1100, 900), 1000, 800)).toBe(50 * 50);
  });

  it('is zero when entirely off screen', () => {
    expect(visibleAreaOf(rect(0, 900, 100, 1000), 1000, 800)).toBe(0);
    expect(visibleAreaOf(rect(-200, 0, -100, 100), 1000, 800)).toBe(0);
  });
});
