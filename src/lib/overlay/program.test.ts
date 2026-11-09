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
    expect(parseOverlayCommand({ type: 'blackout', title: '  Show  ' })).toEqual({
      type: 'blackout',
      title: 'Show',
      pictures: null,
      prompt: false,
      attempt: 0,
      status: null,
      canNext: true,
    });
    expect(parseOverlayCommand({ type: 'blackout', prompt: true, attempt: 2, status: ' Blocked ' })).toEqual({
      type: 'blackout',
      title: null,
      pictures: null,
      prompt: true,
      attempt: 2,
      status: 'Blocked',
      canNext: true,
    });
    expect(parseOverlayCommand({ type: 'blackout', canNext: false })).toMatchObject({ canNext: false });
    expect(parseOverlayCommand({ type: 'blackout', attempt: -1 })).toMatchObject({ attempt: 0 });
    // Loading: the ad pictures; an empty program means the site's images.
    expect(parseOverlayCommand({ type: 'blackout', pictures: { host: 'a.example', items: [] } })).toMatchObject({
      pictures: { host: 'a.example', items: [{ kind: 'img', keyword: null, durationS: null }] },
    });
    expect(parseOverlayCommand({ type: 'blackout', pictures: { host: 1, items: [] } })).toMatchObject({ pictures: null });
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

describe('pictures command', () => {
  it('parses pause and show pictures, defaulting the program', () => {
    expect(
      parseOverlayCommand({ type: 'pictures', purpose: 'show', host: 'a.com', items: [{ kind: 'img', keyword: 'sea' }], paused: true }),
    ).toEqual({
      type: 'pictures',
      purpose: 'show',
      host: 'a.com',
      items: [{ kind: 'img', keyword: 'sea', durationS: null }],
      paused: true,
    });
    expect(parseOverlayCommand({ type: 'pictures', purpose: 'pause', host: 'a.com', items: [], paused: true })).toMatchObject({
      items: [{ kind: 'img', keyword: null, durationS: null }],
    });
  });

  it('rejects unknown purposes and missing flags', () => {
    expect(parseOverlayCommand({ type: 'pictures', purpose: 'ad', host: 'a.com', items: [], paused: false })).toBeNull();
    expect(parseOverlayCommand({ type: 'pictures', purpose: 'show', host: 'a.com', items: [] })).toBeNull();
  });
});

describe('shield command', () => {
  it('requires the maximized flag', () => {
    expect(parseOverlayCommand({ type: 'shield', maximized: true, seekBand: 24 })).toEqual({
      type: 'shield',
      maximized: true,
      seekBand: 24,
    });
    expect(parseOverlayCommand({ type: 'shield', maximized: false })).toEqual({
      type: 'shield',
      maximized: false,
      seekBand: 0,
    });
    expect(parseOverlayCommand({ type: 'shield', maximized: false, seekBand: 9999 })).toMatchObject({ seekBand: 200 });
    expect(parseOverlayCommand({ type: 'shield' })).toBeNull();
  });
});

describe('read command', () => {
  it('parses a page snapshot to read', () => {
    const cmd = { type: 'read', id: 3, url: 'https://a.com/story', html: '<p>hi</p>', wpm: 200, durS: null };
    expect(parseOverlayCommand(cmd)).toEqual(cmd);
    expect(parseOverlayCommand({ ...cmd, durS: 90 })).toMatchObject({ durS: 90 });
    expect(parseOverlayCommand({ ...cmd, durS: -1 })).toMatchObject({ durS: null });
  });

  it('rejects odd addresses and speeds', () => {
    const cmd = { type: 'read', id: 3, url: 'https://a.com/story', html: '', wpm: 200, durS: null };
    expect(parseOverlayCommand({ ...cmd, url: 'javascript:alert(1)' })).toBeNull();
    expect(parseOverlayCommand({ ...cmd, wpm: 0 })).toBeNull();
    expect(parseOverlayCommand({ ...cmd, id: 'x' })).toBeNull();
    expect(parseOverlayCommand({ ...cmd, html: null })).toBeNull();
  });

  it('parses what the reader says back', () => {
    expect(parseOverlayEvent({ type: 'read-started', id: 3, durationS: 120 })).toEqual({ type: 'read-started', id: 3, durationS: 120 });
    expect(parseOverlayEvent({ type: 'read-started', id: 3 })).toBeNull();
    expect(parseOverlayEvent({ type: 'read-failed', id: 3 })).toEqual({ type: 'read-failed', id: 3 });
    expect(parseOverlayEvent({ type: 'read-done', id: 3 })).toEqual({ type: 'read-done', id: 3 });
    expect(parseOverlayEvent({ type: 'read-done' })).toBeNull();
  });
});

describe('parseOverlayEvent', () => {
  const key = { type: 'key', key: 'k', code: 'KeyK', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false };

  it('accepts dismiss, and clicks with coordinates', () => {
    for (const type of ['dismiss', 'undismiss', 'start', 'next']) expect(parseOverlayEvent({ type })).toEqual({ type });
    for (const type of ['click', 'dblclick']) {
      expect(parseOverlayEvent({ type, x: 0.2, y: 0.9 })).toEqual({ type, x: 0.2, y: 0.9 });
      expect(parseOverlayEvent({ type })).toBeNull();
    }
    expect(parseOverlayEvent({ type: 'other' })).toBeNull();
    expect(parseOverlayEvent(null)).toBeNull();
  });

  it('validates activity coordinates', () => {
    expect(parseOverlayEvent({ type: 'activity', x: 0.5, y: 1 })).toEqual({ type: 'activity', x: 0.5, y: 1 });
    expect(parseOverlayEvent({ type: 'activity', x: 2, y: 0 })).toBeNull();
    expect(parseOverlayEvent({ type: 'activity', x: 0.1 })).toBeNull();
  });

  it('validates forwarded keys and drops extra fields', () => {
    expect(parseOverlayEvent({ ...key, extra: 1 })).toEqual(key);
    expect(parseOverlayEvent({ ...key, key: '' })).toBeNull();
    expect(parseOverlayEvent({ ...key, key: 'x'.repeat(33) })).toBeNull();
    expect(parseOverlayEvent({ ...key, ctrlKey: 'yes' })).toBeNull();
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
