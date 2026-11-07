import { describe, expect, it } from 'vitest';
import { PAUSE_PICTURES_DELAY_MS, pausePicturesDue, type PauseFacts } from './pause';

const paused: PauseFacts = {
  enabled: true,
  paused: true,
  ended: false,
  seeking: false,
  readyState: 4,
  currentTime: 120,
  pausedForMs: PAUSE_PICTURES_DELAY_MS,
  isShow: true,
  adActive: false,
};

describe('pausePicturesDue', () => {
  it('covers a show paused for a moment', () => {
    expect(pausePicturesDue(paused)).toBe(true);
  });

  it('waits out quick pause / play', () => {
    expect(pausePicturesDue({ ...paused, pausedForMs: PAUSE_PICTURES_DELAY_MS - 1 })).toBe(false);
    expect(pausePicturesDue({ ...paused, pausedForMs: null })).toBe(false);
  });

  it.each<[string, Partial<PauseFacts>]>([
    ['the setting is off', { enabled: false }],
    ['it is playing (or buffering)', { paused: false }],
    ['it ended', { ended: true }],
    ['it is seeking', { seeking: true }],
    ['it is still loading', { readyState: 1 }],
    ['it never played', { currentTime: 0 }],
    ['it is not a show', { isShow: false }],
    ['an ad is on', { adActive: true }],
  ])('not when %s', (_why, patch) => {
    expect(pausePicturesDue({ ...paused, ...patch })).toBe(false);
  });
});
