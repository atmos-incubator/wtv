import { describe, expect, it } from 'vitest';
import { STICKY_MS, parseLoadingPicture, sameSource } from './loading-picture';

const stored = (at: number, src: unknown = { type: 'library', id: 'abc' }) =>
  JSON.stringify({ src, isVideo: false, durationMs: 4000, at });

describe('parseLoadingPicture', () => {
  it('returns the picture while it is fresh', () => {
    expect(parseLoadingPicture(stored(1000), 1000 + STICKY_MS)).toEqual({
      kind: 'img',
      src: { type: 'library', id: 'abc' },
      isVideo: false,
      durationMs: 4000,
    });
  });

  it('forgets it after a while', () => {
    expect(parseLoadingPicture(stored(1000), 1001 + STICKY_MS)).toBeNull();
  });

  it('ignores junk', () => {
    expect(parseLoadingPicture(null, 0)).toBeNull();
    expect(parseLoadingPicture('{', 0)).toBeNull();
    expect(parseLoadingPicture(stored(0, { type: 'library', id: 5 }), 0)).toBeNull();
    expect(parseLoadingPicture(JSON.stringify({ src: { type: 'url', url: '/a.jpg' } }), 0)).toBeNull();
  });
});

describe('sameSource', () => {
  it('compares by id or url', () => {
    expect(sameSource({ type: 'library', id: 'a' }, { type: 'library', id: 'a' })).toBe(true);
    expect(sameSource({ type: 'library', id: 'a' }, { type: 'url', url: 'a' })).toBe(false);
    expect(sameSource({ type: 'url', url: '/x' }, { type: 'url', url: '/y' })).toBe(false);
  });
});
