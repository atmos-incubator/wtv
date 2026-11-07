import { describe, expect, it } from 'vitest';
import { nextLap, reshuffle, shuffled, startOrder, validOrder, type Random } from './order';

/** A repeatable stand-in for Math.random. */
function seeded(seed: number): Random {
  // mulberry32
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

describe('play order', () => {
  it('plays in order, from the chosen entry', () => {
    expect(startOrder(4, null, false)).toEqual({ order: [0, 1, 2, 3], index: 0 });
    expect(startOrder(4, 2, false)).toEqual({ order: [0, 1, 2, 3], index: 2 });
    expect(startOrder(4, 9, false).index).toBe(3);
  });

  it('shuffles every entry once, with the chosen one first', () => {
    const any = startOrder(8, null, true, seeded(1));
    expect(sorted(any.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(any.index).toBe(0);
    for (let seed = 0; seed < 20; seed++) {
      const from = startOrder(8, 5, true, seeded(seed));
      expect(from.order[0]).toBe(5);
      expect(sorted(from.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it('really shuffles', () => {
    const firsts = new Set<number>();
    for (let seed = 0; seed < 50; seed++) firsts.add(shuffled([0, 1, 2, 3, 4], seeded(seed))[0]!);
    expect(firsts.size).toBe(5);
  });

  it('starts each shuffled lap with anything but the entry that just played', () => {
    for (let seed = 0; seed < 50; seed++) {
      const lap = nextLap([2, 0, 3, 1], true, seeded(seed));
      expect(lap[0]).not.toBe(1);
      expect(sorted(lap)).toEqual([0, 1, 2, 3]);
    }
    expect(nextLap([0], true)).toEqual([0]);
    expect(nextLap([0, 1, 2], false)).toEqual([0, 1, 2]);
  });

  it('reshuffles around the current entry', () => {
    const r = reshuffle({ order: [3, 1, 4, 0, 2], index: 2 }, seeded(7));
    expect(r.index).toBe(0);
    expect(r.order[0]).toBe(4);
    expect(sorted(r.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('falls back to in order for missing or broken saved orders', () => {
    expect(validOrder(undefined, 3)).toEqual([0, 1, 2]);
    expect(validOrder([0, 0, 1], 3)).toEqual([0, 1, 2]);
    expect(validOrder([0, 1], 3)).toEqual([0, 1, 2]);
    expect(validOrder([2, 0, 1], 3)).toEqual([2, 0, 1]);
  });
});
