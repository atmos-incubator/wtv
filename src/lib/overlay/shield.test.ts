import { describe, expect, it } from 'vitest';
import type { CandidateFeatures } from '../media/score';
import { MIN_SHIELD_HEIGHT, isShow, shieldRect } from './shield';

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
