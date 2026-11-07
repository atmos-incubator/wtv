/**
 * The site's `player` box: the matched element that holds the primary media. A page can
 * have more than one match (an inline preview player, a hidden mini player), and the
 * first in document order isn't necessarily the one playing. DOM-only.
 */
import type { Matcher } from '../sites/schema';
import { deepQueryAll } from './query';

/** Whether `inner` is `outer` or inside it, crossing shadow-root boundaries. */
export function containsDeep(outer: Node, inner: Node): boolean {
  for (let n: Node | null = inner; n; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) {
    if (n === outer) return true;
  }
  return false;
}

function hasBox(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Whether a previously found player box is still the right one. */
export function isPlayerFor(el: Element, media: Element | null): boolean {
  return el.isConnected && hasBox(el) && (!media || containsDeep(el, media));
}

export function findPlayer(matchers: readonly Matcher[] | undefined, media: Element | null): Element | null {
  if (!matchers?.length) return null;
  const all: Element[] = [];
  for (const m of matchers) all.push(...deepQueryAll(m.selector).elements);
  if (media) {
    const owner = all.find((el) => hasBox(el) && containsDeep(el, media));
    if (owner) return owner;
  }
  return all.find(hasBox) ?? null;
}
