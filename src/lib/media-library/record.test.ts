import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '../sites/schema';
import {
  describeLength,
  entryLengthS,
  formatClock,
  libraryKey,
  mergeRecord,
  parseRecord,
  playlistLength,
  coverRecords,
  thumbnailOriginsFor,
  thumbnailStale,
} from './record';

describe('libraryKey', () => {
  it('files spellings of one video together', () => {
    const key = 'youtube.com/watch?v=abc';
    expect(libraryKey('https://www.youtube.com/watch?v=abc')).toBe(key);
    expect(libraryKey('https://m.youtube.com/watch?v=abc&t=97&si=x&utm_source=y#wtv:t=5')).toBe(key);
    expect(libraryKey('http://youtube.com/watch/?v=abc')).toBe('youtube.com/watch?v=abc');
  });

  it('keeps what identifies the media, in a stable order', () => {
    expect(libraryKey('https://a.com/v?b=2&a=1')).toBe(libraryKey('https://a.com/v?a=1&b=2'));
    expect(libraryKey('https://a.com/v?id=1')).not.toBe(libraryKey('https://a.com/v?id=2'));
    expect(libraryKey('https://a.com/')).toBe('a.com/');
  });

  it('rejects non-web URLs', () => {
    expect(libraryKey('chrome://settings')).toBeNull();
    expect(libraryKey('nope')).toBeNull();
  });
});

describe('mergeRecord', () => {
  const url = 'https://www.youtube.com/watch?v=abc';

  it('creates, then fills in without erasing', () => {
    const a = mergeRecord(null, { url, title: '  First   video ', durationS: 253.04, thumbnailUrl: 'https://i.ytimg.com/a.jpg' }, 1)!;
    expect(a).toMatchObject({
      key: 'youtube.com/watch?v=abc',
      title: 'First video',
      creator: null,
      durationS: 253,
      thumbnailUrl: 'https://i.ytimg.com/a.jpg',
      status: 'ok',
      updatedAt: 1,
    });
    const b = mergeRecord(a, { url, title: null, creator: 'Chan', status: 'gone' }, 2)!;
    expect(b).toMatchObject({ title: 'First video', creator: 'Chan', durationS: 253, status: 'gone', updatedAt: 2 });
  });

  it('drops junk durations and thumbnails, and forgets the duration of live media', () => {
    const r = mergeRecord(null, { url, durationS: NaN, thumbnailUrl: 'javascript:x' }, 1)!;
    expect([r.durationS, r.thumbnailUrl]).toEqual([null, null]);
    expect(mergeRecord({ ...r, durationS: 60 }, { url, live: true }, 2)!.durationS).toBeNull();
  });

  it('knows when the cached thumbnail is out of date', () => {
    const r = mergeRecord(null, { url, thumbnailUrl: 'https://i.ytimg.com/a.jpg' }, 1)!;
    expect(thumbnailStale(r)).toBe(true);
    const cached = mergeRecord(r, { url, thumbnailCachedFrom: 'https://i.ytimg.com/a.jpg' }, 2)!;
    expect(thumbnailStale(cached)).toBe(false);
    expect(thumbnailStale(mergeRecord(cached, { url, thumbnailUrl: 'https://i.ytimg.com/b.jpg' }, 3)!)).toBe(true);
  });

  it('round-trips through storage, dropping malformed records', () => {
    const r = mergeRecord(null, { url, title: 'T', lastPlayedAt: 5 }, 1)!;
    expect(parseRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(parseRecord({ key: 1 })).toBeNull();
    expect(parseRecord({ key: 'k', url: 'u', status: 'weird' })?.status).toBe('ok');
  });
});

describe('lengths', () => {
  it('measures what an entry plays', () => {
    expect(entryLengthS({ startS: null, endS: null }, 253)).toBe(253);
    expect(entryLengthS({ startS: 60, endS: null }, 253)).toBe(193);
    expect(entryLengthS({ startS: 60, endS: 150 }, 253)).toBe(90);
    expect(entryLengthS({ startS: 60, endS: 150 }, null)).toBe(90);
    expect(entryLengthS({ startS: 60, endS: 900 }, 253)).toBe(193);
    expect(entryLengthS({ startS: null, endS: null }, null)).toBeNull();
    expect(entryLengthS({ startS: 300, endS: null }, 253)).toBe(0);
  });

  it('totals a playlist', () => {
    const total = playlistLength([3600, 1800 + 600, null, 300, null]);
    expect(total).toEqual({ totalS: 6300, unknown: 2 });
    expect(describeLength(total, 5)).toBe('about 1 h 45 min, 2 entries unknown');
    expect(describeLength({ totalS: 7200, unknown: 0 }, 3)).toBe('about 2 h');
    expect(describeLength({ totalS: 1500, unknown: 1 }, 3)).toBe('about 25 min, 1 entry unknown');
    expect(describeLength({ totalS: 30, unknown: 0 }, 1)).toBe('under a minute');
    expect(describeLength({ totalS: 0, unknown: 2 }, 2)).toBe('Length unknown until the entries have played');
    expect(describeLength({ totalS: 0, unknown: 0 }, 0)).toBe('');
  });

  it('formats clock times', () => {
    expect(formatClock(253)).toBe('4:13');
    expect(formatClock(3723.4)).toBe('1:02:03');
    expect(formatClock(59.6)).toBe('1:00');
  });
});

describe('thumbnailOriginsFor', () => {
  const sites = [
    { id: 'youtube.com', domains: ['youtube.com'], thumbnailHosts: ['i.ytimg.com'] },
    { id: 'vimeo.com', domains: ['vimeo.com'] },
  ] as unknown as SiteConfig[];

  it('asks for the thumbnail hosts of the sites in the playlist', () => {
    expect(
      thumbnailOriginsFor(['https://www.youtube.com/watch?v=a', 'https://m.youtube.com/watch?v=b', 'https://vimeo.com/1', 'x'], sites),
    ).toEqual(['*://i.ytimg.com/*']);
    expect(thumbnailOriginsFor(['https://vimeo.com/1'], sites)).toEqual([]);
  });
});

describe('coverRecords', () => {
  const rec = (id: string, lastPlayedAt: number | null, thumb = true) =>
    mergeRecord(null, { url: `https://a.com/v?id=${id}`, thumbnailUrl: thumb ? `https://img.a.com/${id}.jpg` : null, ...(lastPlayedAt ? { lastPlayedAt } : {}) }, 1)!;
  const records = new Map([rec('1', 10), rec('2', 30), rec('3', null), rec('4', 20), rec('5', 40, false)].map((r) => [r.key, r]));

  it('puts the most recently played first, then the rest in playlist order, once each', () => {
    const urls = ['1', '3', '2', '4', '5', '1', 'missing'].map((id) => `https://a.com/v?id=${id}`);
    expect(coverRecords(urls, records).map((r) => r.thumbnailUrl)).toEqual([
      'https://img.a.com/2.jpg',
      'https://img.a.com/4.jpg',
      'https://img.a.com/1.jpg',
      'https://img.a.com/3.jpg',
    ]);
    expect(coverRecords([], records)).toEqual([]);
  });
});
