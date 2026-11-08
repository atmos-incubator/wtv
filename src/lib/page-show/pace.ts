/**
 * Pages as shows (playlist entries with `view=read` / `view=scroll`): speeds and timing.
 * Pure.
 *
 *   - read: the article, scrolled so a reading line moves down it at `wpm` words per
 *     minute, held at READ_LINE of the screen height. A lead-in on the title first, a
 *     dwell at the end. `dur=` fits the whole thing into that time instead.
 *   - scroll: the page itself, `pxPerS` pixels a second, then a dwell at the bottom.
 */

export const DEFAULT_WPM = 180;
export const DEFAULT_SCROLL_PX_S = 30;
export const MIN_WPM = 30;
export const MAX_WPM = 1000;
export const MIN_SCROLL_PX_S = 1;
export const MAX_SCROLL_PX_S = 2000;
/** On the title before reading starts. */
export const LEAD_IN_S = 4;
/** At the end (the bottom of the page / article) before the next entry. */
export const DWELL_S = 5;
/** A page that keeps growing (infinite scroll) ends after this, unless `dur=` says otherwise. */
export const MAX_SCROLL_S = 15 * 60;
/** Where the reading line sits, as a fraction of the screen height. */
export const READ_LINE = 0.35;

export type SpeedUnit = 'wpm' | 'px/s';

export interface Speed {
  value: number;
  /** Null: not given (it's whatever the entry's view reads it as). */
  unit: SpeedUnit | null;
}

/** "200", "200wpm", "200 wpm", "40px/s", "40 px". */
export function parseSpeed(text: string): Speed | null {
  const m = /^(\d+(?:\.\d+)?)\s*(wpm|px\/s|px)?$/i.exec(text.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!(value > 0)) return null;
  const unit = m[2] ? (m[2].toLowerCase() === 'wpm' ? 'wpm' : 'px/s') : null;
  return { value, unit };
}

/** The range check for a speed in `unit`; null when fine, else the problem. */
export function speedProblem(value: number, unit: SpeedUnit): string | null {
  const [min, max] = unit === 'wpm' ? [MIN_WPM, MAX_WPM] : [MIN_SCROLL_PX_S, MAX_SCROLL_PX_S];
  return value < min || value > max ? `between ${min} and ${max} ${unit}` : null;
}

export function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(/\S+/g)) n++;
  return n;
}

export interface ReadPlan {
  leadS: number;
  /** Reading time: the reading line goes from the top of the article to its end. */
  readS: number;
  dwellS: number;
  totalS: number;
}

/** `durS`: the entry's `dur=` (or end time): everything fits into it. */
export function readPlan(words: number, wpm: number, durS: number | null): ReadPlan {
  if (durS !== null && durS > 0) {
    const leadS = Math.min(LEAD_IN_S, durS * 0.1);
    const dwellS = Math.min(DWELL_S, durS * 0.1);
    return { leadS, readS: Math.max(0.5, durS - leadS - dwellS), dwellS, totalS: durS };
  }
  const readS = Math.max(5, (words / Math.max(1, wpm)) * 60);
  return { leadS: LEAD_IN_S, readS, dwellS: DWELL_S, totalS: LEAD_IN_S + readS + DWELL_S };
}

/**
 * Where the article should be scrolled to `t` seconds in (paused time not counted):
 * the reading line has moved `progress` of the way down the content, and is kept at
 * READ_LINE of the screen once the content has moved that far.
 */
export function readScrollTop(t: number, plan: ReadPlan, contentPx: number, viewportPx: number): number {
  const max = Math.max(0, contentPx - viewportPx);
  if (t <= plan.leadS || max === 0) return 0;
  const progress = Math.min(1, (t - plan.leadS) / plan.readS);
  return Math.round(Math.min(max, Math.max(0, progress * contentPx - viewportPx * READ_LINE)));
}

/** Scroll mode's estimate, for the media library's length: the page as it is now. */
export function scrollDurationS(scrollablePx: number, pxPerS: number, durS: number | null): number {
  if (durS !== null && durS > 0) return durS;
  return Math.min(MAX_SCROLL_S, Math.max(0, scrollablePx) / pxPerS + DWELL_S);
}
