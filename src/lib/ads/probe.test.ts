import { describe, expect, it } from 'vitest';
import { intersects, mentionsSkip, probeSignature, rectLabel, samplePoints, type AdProbe } from './probe';

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe('ad probe helpers', () => {
  it('labels rects compactly', () => {
    expect(rectLabel(box(10.4, -300.6, 853.2, 480))).toBe('853×480 @ 10,-301');
  });

  it('tests overlap, with slop for buttons at an edge', () => {
    const area = box(0, 0, 100, 100);
    expect(intersects(box(50, 50, 10, 10), area)).toBe(true);
    expect(intersects(box(110, 50, 10, 10), area)).toBe(false);
    expect(intersects(box(110, 50, 10, 10), area, 24)).toBe(true);
    expect(intersects(box(0, -500, 100, 100), area)).toBe(false);
  });

  it('samples a 3×3 grid, only where it is on screen', () => {
    expect(samplePoints(box(0, 0, 600, 300), 1000, 1000)).toHaveLength(9);
    // Pushed two-thirds above the viewport: only the bottom row is left.
    const pts = samplePoints(box(0, -200, 600, 300), 1000, 1000);
    expect(pts).toHaveLength(3);
    expect(pts.every((p) => p.y === 50)).toBe(true);
    expect(samplePoints(box(0, -400, 600, 300), 1000, 1000)).toEqual([]);
  });

  it('finds "skip" in text or attributes, but not seek or navigation buttons', () => {
    expect(mentionsSkip(['', '', 'ytp-ad-skip-button-container', '', ''])).toBe(true);
    expect(mentionsSkip(['Skip', '', '', '', ''])).toBe(true);
    expect(mentionsSkip(['', '', '', 'Skip ad', ''])).toBe(true);
    expect(mentionsSkip(['Skip navigation', 'skip-navigation', '', '', ''])).toBe(false);
    expect(mentionsSkip(['', '', '', 'Skip forward 10 seconds', ''])).toBe(false);
    expect(mentionsSkip(['Sponsored', '', 'ad-badge', '', ''])).toBe(false);
  });

  it('ignores the timestamp when deciding whether to log again', () => {
    const p: AdProbe = { at: 100, areas: [], under: {}, stack: {}, above: {}, skip: [], frames: [] };
    expect(probeSignature(p)).toBe(probeSignature({ ...p, at: 900 }));
    expect(probeSignature(p)).not.toBe(probeSignature({ ...p, under: { player: ['div ×9'] } }));
  });
});
