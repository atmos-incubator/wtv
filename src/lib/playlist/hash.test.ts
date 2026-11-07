import { describe, expect, it } from 'vitest';
import { formatWtvHash, parseWtvHash, stripWtvHash, withWtvHash } from './hash';
import { AD_SETTLE_MS, endState, seekDecision, type EndInput, type SeekInput } from './seek';

describe('#wtv: hash', () => {
  it('parses times and title', () => {
    expect(parseWtvHash('#wtv:t=97&e=187&d=Some%20Title_with_underscores')).toEqual({
      t: 97,
      end: 187,
      title: 'Some Title_with_underscores',
    });
    expect(parseWtvHash('#wtv:t=1:02:03')).toEqual({ t: 3723, end: null, title: null });
    expect(parseWtvHash('#wtv:e=1:30')).toEqual({ t: null, end: 90, title: null });
    expect(parseWtvHash('#wtv:')).toEqual({ t: null, end: null, title: null });
  });

  it('tolerates junk', () => {
    expect(parseWtvHash('#wtv:t=soon&e=never&d=%E0%A4%A&x=1&=2&nokey')).toEqual({
      t: null,
      end: null,
      title: '%E0%A4%A',
    });
  });

  it('ignores other hashes', () => {
    expect(parseWtvHash('#t=97')).toBeNull();
    expect(parseWtvHash('')).toBeNull();
    expect(parseWtvHash('#/watch/wtv:t=5')).toBeNull();
  });

  it('round-trips', () => {
    const params = { t: 97.5, end: 120.25, title: 'A & B = C #1' };
    expect(parseWtvHash(formatWtvHash(params))).toEqual(params);
    expect(formatWtvHash({ t: null, end: null, title: null })).toBe('#wtv:');
    expect(formatWtvHash({ t: 0, end: 45, title: null })).toBe('#wtv:e=45');
  });

  it('adds itself to entry URLs, but not over a site hash', () => {
    expect(withWtvHash('https://a.com/x?v=1', { t: 5, end: null, title: 'T' })).toBe('https://a.com/x?v=1#wtv:t=5&d=T');
    expect(withWtvHash('https://a.com/x#wtv:t=1', { t: 5, end: null, title: null })).toBe('https://a.com/x#wtv:t=5');
    expect(withWtvHash('https://a.com/#/route', { t: 5, end: null, title: null })).toBe('https://a.com/#/route');
    expect(withWtvHash('nope', { t: 5, end: null, title: null })).toBe('nope');
  });

  it('strips itself only', () => {
    expect(stripWtvHash('https://a.com/x?v=1#wtv:t=5')).toBe('https://a.com/x?v=1');
    expect(stripWtvHash('https://a.com/#/route')).toBe('https://a.com/#/route');
  });
});

describe('seekDecision', () => {
  const ready: SeekInput = {
    startS: 97,
    currentTime: 0,
    duration: 600,
    readyState: 4,
    adActive: false,
    adsInMainVideo: false,
    playingForMs: 0,
  };

  it('seeks as soon as metadata is in, where ads have their own player', () => {
    expect(seekDecision(ready)).toBe('seek');
    expect(seekDecision({ ...ready, readyState: 0 })).toBe('wait');
    expect(seekDecision({ ...ready, duration: NaN })).toBe('wait');
  });

  it('waits out ads, and on ads-in-main-video sites a settle period of ad-free playback', () => {
    expect(seekDecision({ ...ready, adActive: true })).toBe('wait');
    expect(seekDecision({ ...ready, adsInMainVideo: true })).toBe('wait');
    expect(seekDecision({ ...ready, adsInMainVideo: true, playingForMs: AD_SETTLE_MS })).toBe('seek');
  });

  it('seeks back to 0 for an end time with no start (the site resumed further on)', () => {
    expect(seekDecision({ ...ready, startS: 0, currentTime: 300 })).toBe('seek');
  });

  it('skips when there is nothing to do', () => {
    expect(seekDecision({ ...ready, startS: 0 })).toBe('skip');
    expect(seekDecision({ ...ready, duration: Infinity })).toBe('skip');
    expect(seekDecision({ ...ready, duration: 60 })).toBe('skip');
    expect(seekDecision({ ...ready, currentTime: 96 })).toBe('skip');
  });
});

describe('endState', () => {
  const at: EndInput = { currentTime: 100, duration: 600, endS: null, seekDone: true };

  it('reports the media’s own end, and near-end for shows', () => {
    expect(endState(at)).toBeNull();
    expect(endState({ ...at, currentTime: 585 })).toBe('near-end');
    expect(endState({ ...at, currentTime: 599.9 })).toBe('ended');
    expect(endState({ ...at, duration: 20, currentTime: 10 })).toBeNull();
    expect(endState({ ...at, duration: Infinity })).toBeNull();
    expect(endState({ ...at, duration: NaN })).toBeNull();
  });

  it('stops at the end time instead, once the start seek is settled', () => {
    const withEnd = { ...at, endS: 187 };
    expect(endState({ ...withEnd, currentTime: 160 })).toBeNull();
    expect(endState({ ...withEnd, currentTime: 170 })).toBe('near-end');
    expect(endState({ ...withEnd, currentTime: 187 })).toBe('end-time');
    // Before the seek, currentTime may be where the site resumed.
    expect(endState({ ...withEnd, currentTime: 400, seekDone: false })).toBeNull();
  });

  it('ignores an end time past the media’s end', () => {
    expect(endState({ ...at, endS: 900, currentTime: 599.9 })).toBe('ended');
  });
});
