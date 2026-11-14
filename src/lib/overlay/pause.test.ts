import { describe, expect, it } from 'vitest';
import type { CandidateFeatures } from '../media/score';
import { MUTED_SHOW_MIN_SHARE, PAUSE_PICTURES_DELAY_MS, isPausedShow, pausePicturesDue, type PauseFacts } from './pause';

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

describe('isPausedShow', () => {
  const viewportArea = 1920 * 1080;
  const show: CandidateFeatures = {
    key: 'd1',
    isVideo: true,
    playing: false,
    audible: true,
    loop: false,
    visibleArea: 1280 * 720,
    viewportArea,
    duration: 600,
    hasSource: true,
    configMatch: false,
  };

  it('takes any show', () => {
    expect(isPausedShow(show)).toBe(true);
    expect(isPausedShow({ ...show, audible: false, visibleArea: 10, configMatch: true })).toBe(true);
  });

  it('takes a muted one that fills a good part of the window', () => {
    expect(isPausedShow({ ...show, audible: false })).toBe(true);
    expect(isPausedShow({ ...show, audible: false, visibleArea: viewportArea * MUTED_SHOW_MIN_SHARE })).toBe(true);
  });

  it('not a small muted one (a hover preview)', () => {
    expect(isPausedShow({ ...show, audible: false, visibleArea: viewportArea * MUTED_SHOW_MIN_SHARE - 1 })).toBe(false);
    expect(isPausedShow({ ...show, audible: false, viewportArea: 0 })).toBe(false);
  });

  it('not a muted clip or loop, however big', () => {
    expect(isPausedShow({ ...show, audible: false, duration: 12 })).toBe(false);
    expect(isPausedShow({ ...show, audible: false, loop: true })).toBe(false);
    expect(isPausedShow({ ...show, audible: false, isVideo: false })).toBe(false);
  });
});
