import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_MS,
  buildSlides,
  parseOverlayCommand,
  parseOverlayEvent,
  shuffle,
  type ResolvedImage,
} from './program';

const url = (u: string, durationMs: number | null = null): ResolvedImage => ({
  src: { type: 'url', url: u },
  durationMs,
  isVideo: false,
});

describe('parseOverlayCommand', () => {
  it('parses hide and blackout', () => {
    expect(parseOverlayCommand({ type: 'hide' })).toEqual({ type: 'hide' });
    expect(parseOverlayCommand({ type: 'blackout', title: '  Show  ' })).toEqual({ type: 'blackout', title: 'Show' });
    expect(parseOverlayCommand({ type: 'blackout' })).toEqual({ type: 'blackout', title: null });
  });

  it('parses an ad program and drops invalid items', () => {
    const cmd = parseOverlayCommand({
      type: 'ad',
      host: 'youtube.com',
      muted: true,
      items: [
        { kind: 'text', text: 'Breathe', durationS: 20 },
        { kind: 'text', text: 'no duration' },
        { kind: 'img', keyword: ' cats ', durationS: 10 },
        { kind: 'img', keyword: '', durationS: -1 },
        { kind: 'video' },
      ],
    });
    expect(cmd).toEqual({
      type: 'ad',
      host: 'youtube.com',
      muted: true,
      items: [
        { kind: 'text', text: 'Breathe', durationS: 20 },
        { kind: 'img', keyword: 'cats', durationS: 10 },
        { kind: 'img', keyword: null, durationS: null },
      ],
    });
  });

  it('falls back to the default program when no item is valid', () => {
    const cmd = parseOverlayCommand({ type: 'ad', host: 'x.com', muted: false, items: [{ kind: 'nope' }] });
    expect(cmd).toMatchObject({ items: [{ kind: 'img', keyword: null, durationS: null }] });
  });

  it.each([null, 'hide', { type: 'boom' }, { type: 'ad', host: 'x.com', items: 'no', muted: true }])(
    'rejects %j',
    (raw) => {
      expect(parseOverlayCommand(raw)).toBeNull();
    },
  );
});

describe('parseOverlayEvent', () => {
  it('accepts dismiss only', () => {
    expect(parseOverlayEvent({ type: 'dismiss' })).toEqual({ type: 'dismiss' });
    expect(parseOverlayEvent({ type: 'other' })).toBeNull();
  });
});

describe('shuffle', () => {
  it('keeps every element and does not mutate the input', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, () => 0.3);
    expect([...out].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('buildSlides', () => {
  const noShuffle = () => 0.999;

  it('uses item duration, then file-name duration, then the default', () => {
    const slides = buildSlides(
      [
        { kind: 'img', keyword: null, durationS: null },
        { kind: 'img', keyword: 'cats', durationS: 3 },
      ],
      (k) => (k === 'cats' ? [url('c', 9000)] : [url('a', 7000), url('b')]),
      noShuffle,
    );
    expect(slides.map((s) => s.durationMs)).toEqual([7000, DEFAULT_IMAGE_MS, 3000]);
  });

  it('interleaves quotes and images in program order', () => {
    const slides = buildSlides(
      [
        { kind: 'text', text: 'Take a moment to breathe', durationS: 20 },
        { kind: 'img', keyword: null, durationS: null },
        { kind: 'text', text: 'Relax', durationS: 5 },
      ],
      () => [url('a')],
      noShuffle,
    );
    expect(slides.map((s) => s.kind)).toEqual(['text', 'img', 'text']);
    expect(slides[0]).toEqual({ kind: 'text', text: 'Take a moment to breathe', durationMs: 20_000 });
  });

  it('skips image items that resolve to nothing', () => {
    expect(buildSlides([{ kind: 'img', keyword: 'none', durationS: null }], () => [])).toEqual([]);
  });
});
