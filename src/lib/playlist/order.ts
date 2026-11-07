/**
 * Play order for the runner: a list of entry indexes, in the order they play. Pure;
 * `random` is injectable for tests.
 *
 *   - In order: 0, 1, 2, …; playing from entry i starts at position i.
 *   - Shuffled: shuffled once at start and kept in the runner's state, so Previous goes
 *     back through the same order. Playing from entry i puts it first.
 *   - Each lap of a loop is reshuffled, and the entry that just played doesn't come
 *     first in the next lap (when there's anything else to play).
 *   - Reshuffle (popup): the current entry stays on, everything else in a new order after it.
 */

export type Random = () => number;

export interface PlayOrder {
  /** Entry indexes in play order. */
  order: number[];
  /** Position in `order` that's playing. */
  index: number;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function randomInt(n: number, random: Random): number {
  return Math.min(n - 1, Math.floor(random() * n));
}

/** Fisher–Yates, on a copy. */
export function shuffled<T>(items: readonly T[], random: Random = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1, random);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A new run of `n` entries. `from`: the entry to start with, or null for the top (or anywhere, shuffled). */
export function startOrder(n: number, from: number | null, shuffle: boolean, random: Random = Math.random): PlayOrder {
  const first = from === null ? null : Math.max(0, Math.min(from, n - 1));
  if (!shuffle) return { order: range(n), index: first ?? 0 };
  if (first === null) return { order: shuffled(range(n), random), index: 0 };
  return { order: [first, ...shuffled(range(n).filter((i) => i !== first), random)], index: 0 };
}

/** The order for the next lap of a loop. */
export function nextLap(order: readonly number[], shuffle: boolean, random: Random = Math.random): number[] {
  if (!shuffle) return range(order.length);
  const last = order[order.length - 1];
  const next = shuffled(order, random);
  if (next.length > 1 && next[0] === last) {
    const j = 1 + randomInt(next.length - 1, random);
    [next[0], next[j]] = [next[j]!, next[0]!];
  }
  return next;
}

/** Reshuffle while playing: the current entry is now first, the rest shuffled after it. */
export function reshuffle(play: PlayOrder, random: Random = Math.random): PlayOrder {
  const current = play.order[play.index];
  if (current === undefined) return play;
  return { order: [current, ...shuffled(play.order.filter((i) => i !== current), random)], index: 0 };
}

/** A saved order, if it's a permutation of `n` entries; else in order (runs saved before shuffle existed). */
export function validOrder(order: unknown, n: number): number[] {
  if (Array.isArray(order) && order.length === n) {
    const seen = new Set<number>();
    for (const i of order) {
      if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) return range(n);
      seen.add(i);
    }
    return order as number[];
  }
  return range(n);
}
