import { describe, expect, it } from 'vitest';
import { SETTLE_MAX_MS, SETTLE_STABLE_MS, SETTLE_WINDOW_MS, curtainDone, recentlyUnsettled, videoReady } from './settle';

describe('curtainDone', () => {
  it('waits for the box to hold still', () => {
    expect(curtainDone({ upForMs: 1000, stableForMs: SETTLE_STABLE_MS - 1, ready: true })).toBeNull();
    expect(curtainDone({ upForMs: 1000, stableForMs: SETTLE_STABLE_MS, ready: true })).toBe('settled');
  });

  it('waits for the video to be ready', () => {
    expect(curtainDone({ upForMs: 1000, stableForMs: 2000, ready: false })).toBeNull();
  });

  it('gives up after the cap either way', () => {
    expect(curtainDone({ upForMs: SETTLE_MAX_MS, stableForMs: 0, ready: false })).toBe('timeout');
  });
});

describe('videoReady', () => {
  it('needs data to play on, and no seek in progress', () => {
    expect(videoReady(null)).toBe(false);
    expect(videoReady({ readyState: 2, seeking: false })).toBe(false);
    expect(videoReady({ readyState: 3, seeking: true })).toBe(false);
    expect(videoReady({ readyState: 3, seeking: false })).toBe(true);
    expect(videoReady({ readyState: 4, seeking: false })).toBe(true);
  });
});

describe('recentlyUnsettled', () => {
  it('only just after a new video appeared', () => {
    expect(recentlyUnsettled(null, 5000)).toBe(false);
    expect(recentlyUnsettled(1000, 1000 + SETTLE_WINDOW_MS - 1)).toBe(true);
    expect(recentlyUnsettled(1000, 1000 + SETTLE_WINDOW_MS)).toBe(false);
  });
});
