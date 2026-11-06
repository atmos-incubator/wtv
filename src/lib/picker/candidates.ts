/**
 * Build ranked selector candidates for a picked element. DOM-only (content script).
 *
 * Within the element's own root (document or open shadow root), in rough order of how
 * well they survive site updates:
 *   id > test id > itemprop > data-* > name > classes > anchored to a stable ancestor
 *   > structural nth-of-type path (last resort).
 * Elements inside open shadow roots get the hosts' best selectors joined with ` >>> `.
 * Non-unique candidates are kept (an ad indicator may legitimately repeat) but ranked down.
 */
import { deepQueryAll } from '../dom/query';
import type { Candidate } from './messages';
import { ATTRIBUTE_PRIORITY, cssString, isStableAttrValue, isStableClass, isStableId } from './stability';

const MAX_CANDIDATES = 8;
const NON_UNIQUE_PENALTY = 30;

type Root = Document | ShadowRoot;

interface Local {
  selector: string;
  score: number;
  label: string;
}

function rootOf(el: Element): Root {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root : document;
}

function countIn(root: Root, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function stableClasses(el: Element): string[] {
  return [...el.classList].filter(isStableClass).slice(0, 6);
}

function classPart(classes: readonly string[]): string {
  return classes.map((c) => `.${CSS.escape(c)}`).join('');
}

/** A short unique-ish selector for `el` without context, used for anchors and hosts. */
function ownSelector(el: Element, root: Root): string | null {
  if (el.id && isStableId(el.id)) {
    const s = `#${CSS.escape(el.id)}`;
    if (countIn(root, s) === 1) return s;
  }
  for (const { pattern } of ATTRIBUTE_PRIORITY) {
    for (const attr of el.attributes) {
      if (!pattern.test(attr.name) || !isStableAttrValue(attr.value)) continue;
      const s = `${el.localName}[${attr.name}=${cssString(attr.value)}]`;
      if (countIn(root, s) === 1) return s;
    }
  }
  const classes = stableClasses(el);
  if (classes.length > 0) {
    const s = `${el.localName}${classPart(classes)}`;
    if (countIn(root, s) === 1) return s;
  }
  return null;
}

/** Nearest ancestor (within the same root) with a unique own selector. */
function anchorOf(el: Element, root: Root): { el: Element; selector: string } | null {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const s = ownSelector(a, root);
    if (s) return { el: a, selector: s };
  }
  return null;
}

function nthOfType(el: Element): string {
  let index = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.localName === el.localName) index++;
  }
  return `${el.localName}:nth-of-type(${index})`;
}

function localCandidates(el: Element, root: Root): Local[] {
  const out: Local[] = [];
  const seen = new Set<string>();
  const tag = el.localName;

  const add = (selector: string, score: number, label: string) => {
    if (seen.has(selector)) return;
    seen.add(selector);
    let ok = false;
    try {
      ok = el.matches(selector);
    } catch {
      return;
    }
    const count = countIn(root, selector);
    if (!ok || count === 0) return;
    out.push({ selector, score: count === 1 ? score : score - NON_UNIQUE_PENALTY, label });
  };

  if (el.id && isStableId(el.id)) {
    add(`#${CSS.escape(el.id)}`, 100, 'id');
  }

  for (const { pattern, score, label } of ATTRIBUTE_PRIORITY) {
    for (const attr of el.attributes) {
      if (pattern.test(attr.name) && isStableAttrValue(attr.value)) {
        add(`${tag}[${attr.name}=${cssString(attr.value)}]`, score, label);
      }
    }
  }

  const classes = stableClasses(el);
  for (const c of classes) add(`${tag}.${CSS.escape(c)}`, 64, 'class');
  for (let i = 0; i < classes.length; i++) {
    for (let j = i + 1; j < classes.length; j++) {
      add(`${tag}${classPart([classes[i]!, classes[j]!])}`, 60, 'classes');
    }
  }

  const anchor = anchorOf(el, root);
  if (anchor) {
    const tail = classes.length > 0 ? `${tag}${classPart(classes.slice(0, 2))}` : tag;
    add(`${anchor.selector} ${tail}`, 55, 'inside stable ancestor');
  }

  // Structural fallback: nth-of-type steps up to the anchor (or the root).
  const steps: string[] = [];
  for (let n: Element | null = el; n && n !== anchor?.el; n = n.parentElement) {
    steps.unshift(nthOfType(n));
    if (steps.length > 8) break;
  }
  add([anchor?.selector, ...steps].filter(Boolean).join(' > '), 15, 'structure');

  return out.sort((a, b) => b.score - a.score);
}

export function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const classes = [...el.classList].slice(0, 3).map((c) => `.${c}`).join('');
  return `${el.localName}${id}${classes}`;
}

export function generateCandidates(el: Element): Candidate[] {
  // Outermost host first: [host1, host2, ..., el]
  const chain: Element[] = [el];
  for (let root = rootOf(el); root instanceof ShadowRoot; root = rootOf(root.host)) chain.unshift(root.host);

  const prefix = chain
    .slice(0, -1)
    .map((host) => ownSelector(host, rootOf(host)) ?? host.localName)
    .join(' >>> ');

  return localCandidates(el, rootOf(el))
    .slice(0, MAX_CANDIDATES)
    .map((c) => {
      const selector = prefix ? `${prefix} >>> ${c.selector}` : c.selector;
      return { selector, score: c.score, label: c.label, count: deepQueryAll(selector).elements.length };
    });
}
