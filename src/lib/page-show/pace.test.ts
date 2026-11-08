import { describe, expect, it } from 'vitest';
import {
  DWELL_S,
  LEAD_IN_S,
  MAX_SCROLL_S,
  READ_LINE,
  countWords,
  parseSpeed,
  readPlan,
  readScrollTop,
  scrollDurationS,
  speedProblem,
} from './pace';

describe('speeds', () => {
  it('parses numbers with or without a unit', () => {
    expect(parseSpeed('200')).toEqual({ value: 200, unit: null });
    expect(parseSpeed('200wpm')).toEqual({ value: 200, unit: 'wpm' });
    expect(parseSpeed(' 200 WPM ')).toEqual({ value: 200, unit: 'wpm' });
    expect(parseSpeed('40px/s')).toEqual({ value: 40, unit: 'px/s' });
    expect(parseSpeed('12.5 px')).toEqual({ value: 12.5, unit: 'px/s' });
    expect(parseSpeed('0')).toBeNull();
    expect(parseSpeed('fast')).toBeNull();
    expect(parseSpeed('40 mph')).toBeNull();
  });

  it('checks the range per unit', () => {
    expect(speedProblem(200, 'wpm')).toBeNull();
    expect(speedProblem(5, 'wpm')).toBe('between 30 and 1000 wpm');
    expect(speedProblem(3000, 'px/s')).toBe('between 1 and 2000 px/s');
  });
});

describe('reading', () => {
  it('counts words', () => {
    expect(countWords('  one two\nthree  ')).toBe(3);
    expect(countWords('')).toBe(0);
  });

  it('plans a lead-in, the reading time and a dwell', () => {
    const plan = readPlan(900, 180, null);
    expect(plan).toEqual({ leadS: LEAD_IN_S, readS: 300, dwellS: DWELL_S, totalS: LEAD_IN_S + 300 + DWELL_S });
    expect(readPlan(3, 180, null).readS).toBe(5);
  });

  it('fits everything into dur=', () => {
    const plan = readPlan(900, 180, 60);
    expect(plan.totalS).toBe(60);
    expect(plan.leadS + plan.readS + plan.dwellS).toBeCloseTo(60);
    expect(readPlan(900, 180, 2).readS).toBeGreaterThan(0);
  });

  it('keeps the reading line at its place on the screen', () => {
    const plan = readPlan(900, 180, null); // 300 s of reading
    const content = 10_000;
    const screen = 1000;
    expect(readScrollTop(0, plan, content, screen)).toBe(0);
    expect(readScrollTop(LEAD_IN_S, plan, content, screen)).toBe(0);
    // Halfway: the line is at 5000 px, held READ_LINE down the screen.
    expect(readScrollTop(LEAD_IN_S + 150, plan, content, screen)).toBe(5000 - screen * READ_LINE);
    // Never past the end.
    expect(readScrollTop(LEAD_IN_S + 300, plan, content, screen)).toBe(content - screen);
    expect(readScrollTop(10_000, plan, content, screen)).toBe(content - screen);
    // Short enough to fit: no scrolling.
    expect(readScrollTop(100, plan, 800, screen)).toBe(0);
  });
});

describe('scrolling', () => {
  it('estimates the time from the page height', () => {
    expect(scrollDurationS(3000, 30, null)).toBe(100 + DWELL_S);
    expect(scrollDurationS(3000, 30, 45)).toBe(45);
    expect(scrollDurationS(10_000_000, 1, null)).toBe(MAX_SCROLL_S);
  });
});
