import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYS,
  describeAgo,
  explorerOrder,
  fold,
  matchPlaylist,
  parsePlays,
  searchTerms,
  withPlay,
} from './explore';

describe('plays', () => {
  it('keeps only sensible timestamps', () => {
    expect(parsePlays({ a: 5, b: 'x', c: -1, d: Number.NaN })).toEqual({ a: 5 });
    expect(parsePlays(null)).toEqual({});
    expect(parsePlays([1])).toEqual({});
  });

  it('records a play, dropping the oldest past the cap', () => {
    expect(withPlay({ a: 1 }, 'b', 2)).toEqual({ a: 1, b: 2 });
    expect(withPlay({ a: 1 }, 'a', 3)).toEqual({ a: 3 });
    const full = Object.fromEntries(Array.from({ length: MAX_PLAYS }, (_, i) => [`p${i}`, i + 1]));
    const next = withPlay(full, 'new', 10_000);
    expect(Object.keys(next)).toHaveLength(MAX_PLAYS);
    expect(next.new).toBe(10_000);
    expect(next.p0).toBeUndefined();
    expect(next.p1).toBe(2);
  });
});

describe('search', () => {
  it('folds case and accents', () => {
    expect(fold('Café ÉLAN')).toBe('cafe elan');
    expect(searchTerms('  Cats   SLEEPING ')).toEqual(['cats', 'sleeping']);
    expect(searchTerms('   ')).toEqual([]);
  });

  it('matches every playlist with no terms', () => {
    expect(matchPlaylist('Cats', [], [])).toEqual({ nameMatch: true, entries: [] });
  });

  it('matches the whole playlist by name', () => {
    expect(matchPlaylist('Funny Cats', ['a', 'b'], searchTerms('cats'))).toEqual({ nameMatch: true, entries: [] });
  });

  it('otherwise lists the entries that match, terms split between name and title', () => {
    const titles = ['Cat sleeping on a keyboard', null, 'Dog sleeping', 'Café cat'];
    expect(matchPlaylist('Pets', titles, searchTerms('sleeping'))).toEqual({ nameMatch: false, entries: [0, 2] });
    expect(matchPlaylist('Pets', titles, searchTerms('pets cafe'))).toEqual({ nameMatch: false, entries: [3] });
    expect(matchPlaylist('Pets', titles, searchTerms('cat dog'))).toBeNull();
    expect(matchPlaylist('Pets', titles, searchTerms('birds'))).toBeNull();
  });
});

describe('explorerOrder', () => {
  const p = (id: string, name: string, builtin = false) => ({ id, name, builtin });

  it('puts the most recently played first, then yours, then built-ins, by name', () => {
    const items = [p('b1', 'Zoo', true), p('m1', 'Beta'), p('b2', 'Art', true), p('m2', 'Alpha'), p('m3', 'Old'), p('b3', 'Cats', true)];
    const order = explorerOrder(items, { m3: 100, b3: 300, b1: 200 });
    expect(order.map((i) => i.id)).toEqual(['b3', 'b1', 'm3', 'm2', 'm1', 'b2']);
    expect(items[0]!.id).toBe('b1');
  });
});

describe('describeAgo', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const min = 60_000;
  const day = 24 * 60 * min;
  it('says it in words', () => {
    expect(describeAgo(now - 10_000, now)).toBe('just now');
    expect(describeAgo(now + 10_000, now)).toBe('just now');
    expect(describeAgo(now - 5 * min, now)).toBe('5 min ago');
    expect(describeAgo(now - 3 * 60 * min, now)).toBe('3 h ago');
    expect(describeAgo(now - day, now)).toBe('yesterday');
    expect(describeAgo(now - 4 * day, now)).toBe('4 days ago');
    expect(describeAgo(now - 21 * day, now)).toBe('3 weeks ago');
    expect(describeAgo(now - 100 * day, now)).toBe('3 months ago');
    expect(describeAgo(now - 400 * day, now)).toBe('a year ago');
    expect(describeAgo(now - 800 * day, now)).toBe('2 years ago');
  });
});
