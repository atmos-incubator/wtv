/**
 * `view=scroll`: scroll the page itself to the bottom at a steady pace, then dwell there.
 * Content script, top frame.
 *
 *   - Scrolls the document, or the page's main scrolling box when the document itself
 *     doesn't scroll (app-style layouts).
 *   - Done after DWELL_S at the bottom (a page that grows as it's scrolled keeps going),
 *     at `durS` if given, else at MAX_SCROLL_S.
 *   - The viewer scrolling (wheel, touch, keys) holds it for a few seconds, then it goes
 *     on from wherever they left it.
 *   - Time-based steps from both requestAnimationFrame (smooth) and a 1 s timer (rAF
 *     stops in a hidden tab; the playlist should still move on).
 */
import { DWELL_S, MAX_SCROLL_S } from './pace';

/** The viewer scrolled: leave it alone this long. */
const USER_HOLD_MS = 5000;
/** A page too short to scroll still shows this long. */
const MIN_SHOW_S = 10;
/** Scrollable means at least this much to scroll. */
const MIN_SCROLL_PX = 50;
/** Elements looked at when hunting for the main scrolling box. */
const MAX_SCAN = 3000;

export interface ScrollerOptions {
  pxPerS: number;
  durS: number | null;
  onDone: () => void;
}

export interface Scroller {
  /** Pixels left to scroll now. */
  remainingPx(): number;
  stop(): void;
}

function scrollable(el: Element): boolean {
  return el.scrollHeight - el.clientHeight > MIN_SCROLL_PX;
}

/** The document's scroller, else the biggest box on screen that scrolls vertically. */
function scrollTarget(): Element {
  const doc = document.scrollingElement ?? document.documentElement;
  if (scrollable(doc)) return doc;
  let best: Element | null = null;
  let bestArea = 0;
  const all = document.body?.getElementsByTagName('*') ?? [];
  for (let i = 0; i < all.length && i < MAX_SCAN; i++) {
    const el = all[i]!;
    if (el.clientHeight < window.innerHeight * 0.5 || !scrollable(el)) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') continue;
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best ?? doc;
}

export function startScroller(o: ScrollerOptions): Scroller {
  const target = scrollTarget();
  const controller = new AbortController();
  const { signal } = controller;
  const started = performance.now();
  let pos = target.scrollTop;
  let last = started;
  let holdUntil = 0;
  let bottomSince: number | null = null;
  let raf = 0;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    stop();
    o.onDone();
  };

  function step(): void {
    if (finished) return;
    const now = performance.now();
    const dt = Math.min(1.5, (now - last) / 1000);
    last = now;
    if (now < holdUntil) {
      pos = target.scrollTop;
    } else {
      // The page moved under us (anchors, layout shifts, the viewer): carry on from there.
      if (Math.abs(target.scrollTop - pos) > 2) pos = target.scrollTop;
      pos = Math.min(pos + o.pxPerS * dt, target.scrollHeight - target.clientHeight);
      target.scrollTo({ top: pos, behavior: 'instant' });
    }
    const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 2;
    if (!atBottom || o.durS !== null) {
      bottomSince = null;
      return;
    }
    bottomSince ??= now;
    const shownS = (now - started) / 1000;
    if (now - bottomSince >= DWELL_S * 1000 && shownS >= MIN_SHOW_S) finish();
  }

  function loop(): void {
    step();
    raf = requestAnimationFrame(loop);
  }

  function stop(): void {
    controller.abort();
    cancelAnimationFrame(raf);
    clearInterval(tick);
    clearTimeout(cap);
  }

  const hold = () => {
    holdUntil = performance.now() + USER_HOLD_MS;
  };
  for (const type of ['wheel', 'touchstart', 'mousedown'] as const) {
    window.addEventListener(type, hold, { passive: true, capture: true, signal });
  }
  window.addEventListener(
    'keydown',
    (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) hold();
    },
    { capture: true, signal },
  );

  const tick = setInterval(step, 1000);
  const cap = setTimeout(finish, (o.durS ?? MAX_SCROLL_S) * 1000);
  loop();

  return {
    remainingPx: () => Math.max(0, target.scrollHeight - target.clientHeight - target.scrollTop),
    stop,
  };
}
