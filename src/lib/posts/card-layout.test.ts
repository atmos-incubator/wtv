import { describe, expect, it } from 'vitest';
import { PICTURE_SHARE, PICTURE_SHARE_ALONE, PICTURE_SHARE_CAPTION, blockRatio, fitArea, pictureShare, planCard } from './card-layout';

const wide = { width: 1600, height: 900 };
const tall = { width: 900, height: 1600 };

describe('planCard', () => {
  it('has nothing to plan without pictures', () => {
    expect(planCard(wide, [], 300)).toBeNull();
  });

  it('puts a tall picture beside the text on a wide screen', () => {
    expect(planCard(wide, [0.66], 300)).toMatchObject({ layout: 'side', rows: [[0]] });
  });

  it('puts a wide picture under the text', () => {
    expect(planCard(wide, [1.9], 300)).toMatchObject({ layout: 'stack', rows: [[0]] });
    expect(planCard(tall, [1.5], 300)).toMatchObject({ layout: 'stack' });
  });

  it('stacks wide pictures one per row beside the text when that shows them bigger', () => {
    const plan = planCard(wide, [1.8, 1.8], 300);
    expect(plan?.layout).toBe('side');
    expect(plan?.perRow).toBe(1);
  });

  it('puts tall pictures side by side under the text on a tall screen', () => {
    expect(planCard(tall, [0.7, 0.7], 300)).toMatchObject({ layout: 'stack', perRow: 2 });
  });

  it('tries two per row for three or four pictures', () => {
    const plan = planCard(wide, [1, 1, 1, 1], 300);
    expect(plan?.perRow).toBe(2);
    expect(plan?.rows).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('gives pictures more room with no text', () => {
    const withText = planCard(wide, [1.9], 300)!;
    const alone = planCard(wide, [1.9], 0)!;
    expect(fitArea(1600, 900 * 0.85, alone.ratio)).toBeGreaterThan(fitArea(1600, 900 * 0.55, withText.ratio));
  });

  it('gives pictures more room beside a caption than beside a long text', () => {
    expect(pictureShare(0)).toBe(PICTURE_SHARE_ALONE);
    expect(pictureShare(40)).toBe(PICTURE_SHARE_CAPTION);
    expect(pictureShare(600)).toBe(PICTURE_SHARE);
    expect(planCard(wide, [0.8], 40)?.share).toBe(PICTURE_SHARE_CAPTION);
  });

  it('survives junk aspects', () => {
    expect(planCard(wide, [Number.NaN, 0, Infinity], 300)).not.toBeNull();
  });
});

describe('blockRatio', () => {
  it('is the shape of the rows stacked', () => {
    expect(blockRatio([2, 2], [[0, 1]])).toBeCloseTo(4);
    expect(blockRatio([2, 2], [[0], [1]])).toBeCloseTo(1);
    expect(blockRatio([1, 1, 1, 1], [[0, 1], [2, 3]])).toBeCloseTo(1);
  });
});

describe('fitArea', () => {
  it('fits by the tighter side', () => {
    expect(fitArea(100, 100, 2)).toBe(5000);
    expect(fitArea(100, 100, 0.5)).toBe(5000);
    expect(fitArea(0, 100, 1)).toBe(0);
  });
});
