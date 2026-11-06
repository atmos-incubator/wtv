/**
 * Ad probe: what's on the page where the show was, while an ad plays. For finding ad
 * formats the site config doesn't know yet (YouTube's static ads move the <video> out of
 * the way and draw their own Skip button in its place).
 *
 * Areas searched: the site's `player` box, the primary video now, and where the primary
 * video was just before the ad started. For each it records:
 *   - `under`: the top-most page element at a 3×3 grid of points (what the overlay hides),
 *     and the full element stack at the area's centre.
 *   - `skip`: every element in or near the areas (open shadow roots included) whose own
 *     text, id, class, aria-label or title says "skip", with a snippet of its HTML.
 *   - `frames`: iframes overlapping the areas (an ad drawn inside one can't be searched).
 *
 * The pure helpers at the top are unit-tested; probeAds() touches the DOM.
 */
import type { Box } from '../overlay/shield';
import { NOT_AD_SKIP, describeElement } from './skip';

export type AreaName = 'player' | 'video' | 'video-before-ad';

export interface ProbeArea {
  name: AreaName;
  rect: Box;
}

export interface ProbeHit {
  /** tag#id.class of the element that says "skip". */
  element: string;
  /** The element a click should go to (itself, or its closest button-like ancestor). */
  target: string;
  text: string;
  rect: string;
  visible: boolean;
  /** Which areas it overlaps. Empty: found elsewhere on the page. */
  areas: AreaName[];
  /** outerHTML of the target's parent, truncated. */
  html: string;
}

export interface AdProbe {
  /** Milliseconds since the ad started. */
  at: number;
  areas: { name: AreaName; rect: string }[];
  /** Top-most element per sample point, by area: "element ×points". */
  under: Record<string, string[]>;
  /** Element stack at each area's centre, top first. */
  stack: Record<string, string[]>;
  skip: ProbeHit[];
  frames: { src: string; rect: string }[];
}

/** Elements of ours that hit-testing returns (the overlay host); skipped in `under`. */
export const WTV_UI_ATTR = 'data-wtv-ui';
const SNIPPET_CHARS = 1500;
// Not [tabindex]: players are focusable (YouTube's #movie_player has tabindex=-1), so
// closest() would hand back the whole player.
const CLICK_TARGETS = 'button, [role="button"], a[href]';
/** Element stacks deeper than this are cut. */
const STACK_DEPTH = 8;
/** Pixels around an area still counted as "in" it (Skip buttons sit at the edge). */
const AREA_SLOP = 24;

export function rectLabel(r: Box): string {
  return `${Math.round(r.width)}×${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`;
}

export function intersects(a: Box, b: Box, slop = 0): boolean {
  return (
    a.left < b.left + b.width + slop &&
    b.left - slop < a.left + a.width &&
    a.top < b.top + b.height + slop &&
    b.top - slop < a.top + a.height
  );
}

/** A 3×3 grid of points inside `r`, clipped to the viewport; empty if none is on screen. */
export function samplePoints(r: Box, viewportWidth: number, viewportHeight: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (const fy of [1 / 6, 1 / 2, 5 / 6]) {
    for (const fx of [1 / 6, 1 / 2, 5 / 6]) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (x >= 0 && y >= 0 && x < viewportWidth && y < viewportHeight) points.push({ x, y });
    }
  }
  return points;
}

/** Whether these strings (own text, id, class, aria-label, title) mention an ad's Skip. */
export function mentionsSkip(parts: readonly string[]): boolean {
  const all = parts.join(' ');
  return /skip/i.test(all) && !NOT_AD_SKIP.test(all);
}

/** Every element under `root`, descending into open shadow roots. */
function* deepElements(root: Document | ShadowRoot): Generator<Element> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as Element;
    yield el;
    if (el.shadowRoot) yield* deepElements(el.shadowRoot);
  }
}

function ownText(el: Element): string {
  let text = '';
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) text += n.textContent ?? '';
  return text.trim().replace(/\s+/g, ' ');
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

function snippet(el: Element): string {
  const html = (el.parentElement ?? el).outerHTML;
  return html.length > SNIPPET_CHARS ? `${html.slice(0, SNIPPET_CHARS)}…` : html;
}

function topNotOurs(x: number, y: number): Element[] {
  return document.elementsFromPoint(x, y).filter((el) => !el.hasAttribute(WTV_UI_ATTR));
}

export interface ProbeResult {
  probe: AdProbe;
  /** Visible click targets for Skip-looking elements inside an area, best first. */
  candidates: Element[];
}

export function probeAds(areas: readonly ProbeArea[], adStartedAt: number): ProbeResult {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const under: Record<string, string[]> = {};
  const stack: Record<string, string[]> = {};
  for (const area of areas) {
    const counts = new Map<string, number>();
    for (const p of samplePoints(area.rect, vw, vh)) {
      const top = topNotOurs(p.x, p.y)[0];
      const key = top ? describeElement(top) : '(nothing)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    under[area.name] = [...counts].map(([k, n]) => `${k} ×${n}`);
    const cx = area.rect.left + area.rect.width / 2;
    const cy = area.rect.top + area.rect.height / 2;
    stack[area.name] =
      cx >= 0 && cy >= 0 && cx < vw && cy < vh
        ? topNotOurs(cx, cy).slice(0, STACK_DEPTH).map(describeElement)
        : ['(centre off screen)'];
  }

  const skip: ProbeHit[] = [];
  const candidates: { el: Element; button: boolean }[] = [];
  const seen = new Set<Element>();
  const frames: AdProbe['frames'] = [];
  for (const el of deepElements(document)) {
    if (el instanceof HTMLIFrameElement) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && areas.some((a) => intersects(r, a.rect))) {
        frames.push({ src: el.src.slice(0, 200) || '(no src)', rect: rectLabel(r) });
      }
      continue;
    }
    const text = ownText(el);
    const parts = [
      text.length <= 60 ? text : '',
      el.id,
      typeof el.className === 'string' ? el.className : '',
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('title') ?? '',
    ];
    if (!mentionsSkip(parts)) continue;
    const target = el.closest(CLICK_TARGETS) ?? el;
    if (seen.has(target)) continue;
    seen.add(target);
    const r = target.getBoundingClientRect();
    const inAreas = areas.filter((a) => intersects(r, a.rect, AREA_SLOP)).map((a) => a.name);
    const visible = isVisible(target);
    skip.push({
      element: describeElement(el),
      target: describeElement(target),
      text: (target.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
      rect: rectLabel(r),
      visible,
      areas: inAreas,
      html: snippet(target),
    });
    if (visible && inAreas.length > 0) candidates.push({ el: target, button: target.matches(CLICK_TARGETS) });
  }

  return {
    probe: {
      at: Math.round(performance.now() - adStartedAt),
      areas: areas.map((a) => ({ name: a.name, rect: rectLabel(a.rect) })),
      under,
      stack,
      skip,
      frames,
    },
    // Button-like targets first; the DOM order otherwise.
    candidates: [...candidates.filter((c) => c.button), ...candidates.filter((c) => !c.button)].map((c) => c.el),
  };
}

/** What changed between probes worth logging again (ignores the timestamp). */
export function probeSignature(p: AdProbe): string {
  return JSON.stringify([p.areas, p.under, p.skip.map((s) => [s.target, s.visible, s.areas]), p.frames]);
}
