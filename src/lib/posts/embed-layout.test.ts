import { describe, expect, it } from 'vitest';
import { embedLayout } from './embed-layout';

const right = (b: { left: number; width: number }) => b.left + b.width;
const bottom = (b: { top: number; height: number }) => b.top + b.height;

describe('embedLayout', () => {
  it('puts the player left of the post on a wide screen, with even margins', () => {
    const { slot, text } = embedLayout(1920, 1080);
    expect(slot.left).toBeGreaterThan(0);
    expect(slot.width).toBeGreaterThan(text.width);
    expect(text.left - right(slot)).toBe(slot.left);
    expect(1920 - right(text)).toBe(slot.left);
    expect(slot.top).toBe(text.top);
    expect(slot.height).toBe(text.height);
    expect(bottom(slot)).toBe(1080 - slot.top);
  });

  it('stacks them on a tall screen', () => {
    const { slot, text } = embedLayout(800, 1280);
    expect(slot.width).toBe(text.width);
    expect(text.top - bottom(slot)).toBe(slot.top);
    expect(1280 - bottom(text)).toBe(slot.top);
    expect(slot.height).toBeGreaterThan(text.height);
  });

  it('never goes negative', () => {
    const { slot, text } = embedLayout(0, 0);
    for (const n of [...Object.values(slot), ...Object.values(text)]) expect(n).toBeGreaterThanOrEqual(0);
  });
});
