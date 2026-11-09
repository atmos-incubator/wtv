import { describe, expect, it } from 'vitest';
import type { Slide } from '../overlay/program';
import { STICKY_MS, orderLoadingSlides, parseLoadingPicture, sameSource } from './loading-picture';

const stored = (at: number, gen: number | null = 3, src: unknown = { type: 'library', id: 'abc' }) =>
  JSON.stringify({ src, isVideo: false, durationMs: 4000, at, gen });
const slide = { kind: 'img', src: { type: 'library', id: 'abc' }, isVideo: false, durationMs: 4000 } as const;

describe('parseLoadingPicture', () => {
  it('carries the picture on within the same move while it is fresh', () => {
    expect(parseLoadingPicture(stored(1000), 1000 + STICKY_MS, 3)).toEqual({ slide, carry: true });
    expect(parseLoadingPicture(stored(1000, null), 1000, null)).toEqual({ slide, carry: true });
  });

  it('does not carry it to a new move, however fresh', () => {
    expect(parseLoadingPicture(stored(1000), 1000, 4)).toEqual({ slide, carry: false });
    expect(parseLoadingPicture(stored(1000, null), 1000, 4)).toEqual({ slide, carry: false });
  });

  it('does not carry it after a while', () => {
    expect(parseLoadingPicture(stored(1000), 1001 + STICKY_MS, 3)).toEqual({ slide, carry: false });
  });

  it('ignores junk', () => {
    expect(parseLoadingPicture(null, 0, null)).toBeNull();
    expect(parseLoadingPicture('{', 0, null)).toBeNull();
    expect(parseLoadingPicture(stored(0, 3, { type: 'library', id: 5 }), 0, 3)).toBeNull();
    expect(parseLoadingPicture(JSON.stringify({ src: { type: 'url', url: '/a.jpg' } }), 0, null)).toBeNull();
  });
});

describe('orderLoadingSlides', () => {
  const img = (id: string): Slide => ({ kind: 'img', src: { type: 'library', id }, isVideo: false, durationMs: 1000 });
  const ids = (slides: readonly Slide[]) => slides.map((s) => (s.kind === 'img' && s.src.type === 'library' ? s.src.id : s.kind));
  const slides = [img('abc'), img('b'), img('c')];

  it('starts with the carried picture, once', () => {
    const out = orderLoadingSlides([img('b'), img('abc'), img('c')], { slide, carry: true });
    expect(out.carried).toBe(true);
    expect(ids(out.slides)).toEqual(['abc', 'b', 'c']);
  });

  it('moves the last move’s picture to the back', () => {
    const out = orderLoadingSlides(slides, { slide, carry: false });
    expect(out.carried).toBe(false);
    expect(ids(out.slides)).toEqual(['b', 'c', 'abc']);
  });

  it('leaves them alone with nothing remembered', () => {
    expect(ids(orderLoadingSlides(slides, null).slides)).toEqual(['abc', 'b', 'c']);
  });
});

describe('sameSource', () => {
  it('compares by id or url', () => {
    expect(sameSource({ type: 'library', id: 'a' }, { type: 'library', id: 'a' })).toBe(true);
    expect(sameSource({ type: 'library', id: 'a' }, { type: 'url', url: 'a' })).toBe(false);
    expect(sameSource({ type: 'url', url: '/x' }, { type: 'url', url: '/y' })).toBe(false);
  });
});
