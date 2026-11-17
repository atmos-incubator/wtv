/**
 * Hides the page around a new video while the site is still building it (settle.ts has
 * the rules). DOM; content script, top frame.
 *
 * Two layers, both up from the moment it starts, in the same task, so no frame of the
 * half-built page gets painted:
 *
 *   - A stylesheet: `visibility: hidden !important` on everything in <body> except the
 *     kept element (the site's player box, else the video), what's inside it, and its
 *     ancestors (`:has`). The site's suggestions, masthead and comments can't paint, at
 *     any z-index, without anything being removed or moved. Ad indicators and Skip live
 *     inside the player, so they stay visible to ad detection.
 *   - The overlay host's curtain (only under cover pictures): an opaque top-layer layer
 *     that also hides the video when the site briefly lays it out larger than the
 *     pictures (the rAF glue can trail the site's own ResizeObserver by a frame).
 *
 * A kept element inside a shadow root is kept through its outermost shadow host (`:has`
 * doesn't see into shadow trees). No element to keep → nothing is hidden.
 */
import { record } from '../dev/timeline';
import { curtainDone } from './settle';

const ACTIVE_ATTR = 'data-wtv-settling';
const KEEP_ATTR = 'data-wtv-keep';
const STYLE_ATTR = 'data-wtv-settling-style';
const KEEP = `[${KEEP_ATTR}]`;
const CSS = `html[${ACTIVE_ATTR}] body *:not(${KEEP}, ${KEEP} *, :has(${KEEP})) { visibility: hidden !important; }`;

export interface Settler {
  /** Hide the page until it settles; restarts the wait if already settling. */
  start(why: string): void;
  /** Show the page now. */
  stop(why: string): void;
  active(): boolean;
}

export interface SettlerOptions {
  signal: AbortSignal;
  /** The element to leave visible: the player box, else the video. */
  keep: () => Element | null;
  /** The video can play (and the page has loaded). */
  ready: () => boolean;
  /** Settling started or ended. */
  onChange: (active: boolean) => void;
}

/** The element in the document itself that holds `el` (its outermost shadow host). */
function inDocument(el: Element): Element {
  let n: Element = el;
  for (let root = n.getRootNode(); root instanceof ShadowRoot; root = n.getRootNode()) n = root.host;
  return n;
}

function ensureStyle(): void {
  const container = document.head ?? document.documentElement;
  if (!container || container.querySelector(`style[${STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = CSS;
  container.append(style);
}

export function createSettler({ signal, keep, ready, onChange }: SettlerOptions): Settler {
  let since: number | null = null;
  let movedAt = 0;
  let lastRect = '';
  let kept: Element | null = null;
  let raf = 0;

  function tag(el: Element | null): void {
    if (el === kept) return;
    kept?.removeAttribute(KEEP_ATTR);
    kept = el;
    el?.setAttribute(KEEP_ATTR, '');
  }

  /** Keep the right element marked; false when there's nothing to keep. */
  function track(now: number): boolean {
    const el = keep();
    if (!el?.isConnected) return false;
    tag(inDocument(el));
    const r = el.getBoundingClientRect();
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (key !== lastRect || r.width <= 0 || r.height <= 0) {
      lastRect = key;
      movedAt = now;
    }
    return true;
  }

  function loop(): void {
    raf = 0;
    if (since === null) return;
    const now = performance.now();
    if (!track(now)) {
      stop('nothing to keep visible');
      return;
    }
    const done = curtainDone({ upForMs: now - since, stableForMs: now - movedAt, ready: ready() });
    if (done) {
      stop(done);
      return;
    }
    raf = requestAnimationFrame(loop);
  }

  function stop(why: string): void {
    if (since === null) return;
    record('settle', `page shown (${why}) after ${Math.round(performance.now() - since)}ms`);
    since = null;
    cancelAnimationFrame(raf);
    raf = 0;
    document.documentElement?.removeAttribute(ACTIVE_ATTR);
    tag(null);
    onChange(false);
  }

  signal.addEventListener('abort', () => stop('stopped'));

  return {
    start(why) {
      if (signal.aborted || !document.documentElement) return;
      const now = performance.now();
      const was = since !== null;
      lastRect = '';
      if (!track(now)) {
        stop('nothing to keep visible');
        return;
      }
      since = now;
      movedAt = now;
      record('settle', `${was ? 'still settling' : 'page hidden'}: ${why}`);
      ensureStyle();
      document.documentElement.setAttribute(ACTIVE_ATTR, '');
      if (!was) onChange(true);
      if (!raf) raf = requestAnimationFrame(loop);
    },
    stop,
    active: () => since !== null,
  };
}
