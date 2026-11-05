import { describe, expect, it } from 'vitest';
import { MIN_VISIBLE_AREA, isViable, pickPrimary, type CandidateFeatures } from './score';

const VIEWPORT = 1920 * 1080;

function c(key: string, patch: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    key,
    isVideo: true,
    playing: false,
    audible: true,
    loop: false,
    visibleArea: 0,
    viewportArea: VIEWPORT,
    duration: 600,
    hasSource: true,
    configMatch: false,
    ...patch,
  };
}

describe('isViable', () => {
  it('requires a source', () => {
    expect(isViable(c('a', { visibleArea: VIEWPORT, hasSource: false }))).toBe(false);
  });

  it('accepts a big visible paused video', () => {
    expect(isViable(c('a', { visibleArea: MIN_VISIBLE_AREA }))).toBe(true);
  });

  it('rejects a thumbnail-sized video', () => {
    expect(isViable(c('a', { visibleArea: MIN_VISIBLE_AREA - 1, playing: true, audible: false }))).toBe(false);
  });

  it('accepts audio-only media that is playing audibly', () => {
    expect(isViable(c('a', { isVideo: false, playing: true }))).toBe(true);
  });

  it('rejects a hidden config-matched player', () => {
    expect(isViable(c('a', { configMatch: true }))).toBe(false);
  });
});

describe('pickPrimary', () => {
  it('returns null with no viable candidates', () => {
    expect(pickPrimary([c('a'), c('b', { hasSource: false })])).toBeNull();
  });

  it('prefers the main playing video over a muted hover preview', () => {
    const main = c('main', { playing: true, visibleArea: VIEWPORT * 0.4 });
    const preview = c('preview', { playing: true, audible: false, visibleArea: VIEWPORT * 0.05, duration: 15 });
    expect(pickPrimary([preview, main])?.key).toBe('main');
  });

  it('prefers a real video over a muted looping GIF-style video', () => {
    const gif = c('gif', { playing: true, audible: false, loop: true, visibleArea: VIEWPORT * 0.5, duration: 8 });
    const video = c('video', { visibleArea: VIEWPORT * 0.3 });
    expect(pickPrimary([gif, video])?.key).toBe('video');
  });

  it('picks a detached audio player when it is the only thing playing', () => {
    const audio = c('audio', { isVideo: false, playing: true });
    const banner = c('banner', { playing: true, audible: false, loop: true, visibleArea: MIN_VISIBLE_AREA, duration: 5 });
    expect(pickPrimary([banner, audio])?.key).toBe('audio');
  });

  it('gives the config-matched player the edge over a similar unmatched one', () => {
    const matched = c('matched', { visibleArea: VIEWPORT * 0.3, configMatch: true });
    const other = c('other', { visibleArea: VIEWPORT * 0.35 });
    expect(pickPrimary([other, matched])?.key).toBe('matched');
  });

  it('keeps the config-matched main video while a short unmatched ad plays elsewhere', () => {
    const main = c('main', { visibleArea: VIEWPORT * 0.5, configMatch: true });
    const ad = c('ad', { playing: true, visibleArea: VIEWPORT * 0.5, duration: 15 });
    expect(pickPrimary([ad, main], 'main')?.key).toBe('main');
  });

  it('is sticky between near-equal candidates', () => {
    const a = c('a', { visibleArea: VIEWPORT * 0.3 });
    const b = c('b', { visibleArea: VIEWPORT * 0.32 });
    expect(pickPrimary([a, b])?.key).toBe('b');
    expect(pickPrimary([a, b], 'a')?.key).toBe('a');
  });

  it('switches when another candidate is clearly better', () => {
    const paused = c('paused', { visibleArea: VIEWPORT * 0.3 });
    const playing = c('playing', { playing: true, visibleArea: VIEWPORT * 0.3 });
    expect(pickPrimary([paused, playing], 'paused')?.key).toBe('playing');
  });

  it('treats live streams as long-form', () => {
    const live = c('live', { duration: Infinity, visibleArea: VIEWPORT * 0.3 });
    const clip = c('clip', { duration: 10, visibleArea: VIEWPORT * 0.3 });
    expect(pickPrimary([clip, live])?.key).toBe('live');
  });

  it('breaks exact ties by visible area', () => {
    const small = c('small', { visibleArea: VIEWPORT * 2 });
    const big = c('big', { visibleArea: VIEWPORT * 3 });
    expect(pickPrimary([small, big])?.key).toBe('big');
  });
});
