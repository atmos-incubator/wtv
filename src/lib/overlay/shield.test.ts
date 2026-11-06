import { describe, expect, it } from 'vitest';
import type { CandidateFeatures } from '../media/score';
import { MIN_SHIELD_HEIGHT, inSeekBand, isShow, seekFraction, seekTime, shieldRect } from './shield';

const video = { left: 10, top: 20, width: 1280, height: 720 };

describe('shieldRect', () => {
  it('leaves the control bar uncovered', () => {
    expect(shieldRect(video, 48)).toEqual({ left: 10, top: 20, width: 1280, height: 672 });
  });

  it('treats a negative inset as none', () => {
    expect(shieldRect(video, -5)).toEqual(video);
  });

  it('gives up when too little would remain', () => {
    expect(shieldRect({ ...video, height: MIN_SHIELD_HEIGHT + 47 }, 48)).toBeNull();
    expect(shieldRect({ ...video, height: MIN_SHIELD_HEIGHT + 48 }, 48)).not.toBeNull();
    expect(shieldRect({ ...video, width: 0 }, 0)).toBeNull();
  });
});

describe('isShow', () => {
  const show: CandidateFeatures = {
    key: 'd1',
    isVideo: true,
    playing: true,
    audible: true,
    loop: false,
    visibleArea: 1280 * 720,
    viewportArea: 1920 * 1080,
    duration: 600,
    hasSource: true,
    configMatch: false,
  };

  it('accepts a long audible video and live streams', () => {
    expect(isShow(show)).toBe(true);
    expect(isShow({ ...show, duration: Infinity })).toBe(true);
  });

  it('rejects previews, loops, clips, audio and unknown lengths', () => {
    expect(isShow({ ...show, audible: false })).toBe(false);
    expect(isShow({ ...show, loop: true })).toBe(false);
    expect(isShow({ ...show, duration: 12 })).toBe(false);
    expect(isShow({ ...show, duration: NaN })).toBe(false);
    expect(isShow({ ...show, isVideo: false })).toBe(false);
    expect(isShow({ ...show, hasSource: false })).toBe(false);
  });

  it('trusts the site config match', () => {
    expect(isShow({ ...show, audible: false, duration: NaN, configMatch: true })).toBe(true);
  });
});

describe('click to seek', () => {
  it('detects the bottom band', () => {
    expect(inSeekBand(1, 600, 24)).toBe(true);
    expect(inSeekBand(1 - 24 / 600, 600, 24)).toBe(true);
    expect(inSeekBand(1 - 25 / 600, 600, 24)).toBe(false);
    expect(inSeekBand(1, 600, 0)).toBe(false);
  });

  it('maps a click onto the bar, clamped', () => {
    const bar = { left: 100, width: 1000 };
    expect(seekFraction(600, bar)).toBe(0.5);
    expect(seekFraction(50, bar)).toBe(0);
    expect(seekFraction(5000, bar)).toBe(1);
    expect(seekFraction(600, { left: 0, width: 0 })).toBe(0);
  });

  it('seeks within the duration, or a live stream\'s seekable window', () => {
    expect(seekTime(0.25, 600, null)).toBe(150);
    expect(seekTime(0.5, Infinity, { start: 100, end: 300 })).toBe(200);
    expect(seekTime(0.5, NaN, null)).toBeNull();
    expect(seekTime(0.5, Infinity, { start: 5, end: 5 })).toBeNull();
  });
});
