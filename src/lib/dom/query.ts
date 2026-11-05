/**
 * Selector engine for site configs: CSS with ` >>> ` stepping into open shadow roots.
 * DOM-only; runs in content scripts.
 */
import { effectiveWhen, selectorSegments, type Matcher, type RoleName } from '../sites/schema';

export interface QueryResult {
  elements: Element[];
  /** Set when a segment isn't valid CSS. */
  error?: string;
}

export function deepQueryAll(selector: string, root: ParentNode = document): QueryResult {
  const segments = selectorSegments(selector);
  let roots: ParentNode[] = [root];
  for (let i = 0; i < segments.length; i++) {
    const found = new Set<Element>();
    try {
      for (const r of roots) for (const el of r.querySelectorAll(segments[i]!)) found.add(el);
    } catch (err) {
      return { elements: [], error: `invalid selector segment "${segments[i]}": ${(err as Error).message}` };
    }
    if (i === segments.length - 1) return { elements: [...found] };
    roots = [...found].map((el) => el.shadowRoot).filter((r): r is ShadowRoot => r !== null);
  }
  return { elements: [] };
}

export function isElementVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

export interface RoleMatch {
  element: Element;
  /** Index of the matcher that hit, within the role's fallback list. */
  matcherIndex: number;
}

export interface RoleMatchResult {
  match: RoleMatch | null;
  errors: string[];
}

/** First element, trying matchers in order, that satisfies the matcher's condition. */
export function matchRole(role: RoleName, matchers: readonly Matcher[], root: ParentNode = document): RoleMatchResult {
  const errors: string[] = [];
  for (let i = 0; i < matchers.length; i++) {
    const m = matchers[i]!;
    const { elements, error } = deepQueryAll(m.selector, root);
    if (error) {
      errors.push(`${role}[${i}]: ${error}`);
      continue;
    }
    const when = effectiveWhen(role, m);
    const element = when === 'visible' ? elements.find(isElementVisible) : elements[0];
    if (element) return { match: { element, matcherIndex: i }, errors };
  }
  return { match: null, errors };
}

/** The media element for a matched element: itself, or the first media inside it. */
export function mediaWithin(el: Element): HTMLMediaElement | null {
  if (el instanceof HTMLMediaElement) return el;
  const inner = el.querySelector('video, audio') ?? el.shadowRoot?.querySelector('video, audio') ?? null;
  return inner instanceof HTMLMediaElement ? inner : null;
}

/** Visible area of a rect within the viewport, px². */
export function visibleAreaOf(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const w = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const h = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return w * h;
}
