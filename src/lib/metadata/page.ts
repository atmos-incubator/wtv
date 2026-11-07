/**
 * Collects `PageFacts` from the live DOM (content scripts) and extracts the metadata.
 * The parsing and ordering live in extract.ts, which is pure and tested.
 */
import { matchRole } from '../dom/query';
import type { ResolvedSite } from '../sites/overrides';
import { META_ROLES, extractMetadata, type MetaTag, type PageFacts, type PageMetadata } from './extract';

const MAX_LD_SCRIPTS = 20;
const MAX_LD_CHARS = 500_000;
const MAX_VALUE = 5000;

/** Microdata item types worth reading; other items (breadcrumbs, ratings) are skipped. */
const ITEM_TYPES = /VideoObject|Movie|Episode|Clip|Music|Podcast|AudioObject|Article|Posting/i;

/** `itemprop` key, prefixed with the property of the item it's nested in: `author.name`. */
function itempropKey(el: Element): string | null {
  const prop = el.getAttribute('itemprop')?.trim().toLowerCase();
  if (!prop) return null;
  const scope = el.parentElement?.closest('[itemscope]');
  if (!scope) return prop;
  const parentProp = scope.getAttribute('itemprop')?.trim().toLowerCase();
  const root = parentProp ? scope.parentElement?.closest('[itemscope]:not([itemprop])') : scope;
  const type = root?.getAttribute('itemtype') ?? '';
  if (type && !ITEM_TYPES.test(type)) return null;
  return parentProp ? `${parentProp}.${prop}` : prop;
}

function collectTags(doc: Document): MetaTag[] {
  const tags: MetaTag[] = [];
  for (const el of doc.querySelectorAll('meta[content], link[itemprop]')) {
    const value = el.getAttribute('content') ?? el.getAttribute('href');
    if (!value?.trim()) continue;
    const itemprop = el.hasAttribute('itemprop') ? itempropKey(el) : null;
    if (itemprop) {
      tags.push({ key: `itemprop:${itemprop}`, value });
      continue;
    }
    const key = (el.getAttribute('property') ?? el.getAttribute('name'))?.trim().toLowerCase();
    if (key) tags.push({ key, value });
  }
  return tags;
}

/** What a role's element says: `content` for meta tags, `href` for links, else its text. */
export function readRoleValue(el: Element): string {
  let value: string | null = null;
  if (el instanceof HTMLMetaElement) value = el.content;
  else if (el instanceof HTMLLinkElement) value = el.href;
  else if (el instanceof HTMLImageElement) value = el.alt;
  else if (el instanceof HTMLElement) value = el.innerText;
  return (value ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
}

export function collectPageFacts(site: ResolvedSite | null, doc: Document = document): PageFacts {
  const jsonLd = [...doc.querySelectorAll('script[type="application/ld+json"]')]
    .slice(0, MAX_LD_SCRIPTS)
    .map((s) => s.textContent ?? '')
    .filter((t) => t.length > 0 && t.length <= MAX_LD_CHARS);

  const roles: PageFacts['roles'] = {};
  for (const role of META_ROLES) {
    const matchers = site?.config.roles[role];
    if (!matchers?.length) continue;
    const { match } = matchRole(role, matchers, doc);
    const value = match ? readRoleValue(match.element) : '';
    if (value) roles[role] = { value, yours: site?.sources[role] === 'override' };
  }

  return {
    url: doc.location?.href ?? '',
    documentTitle: doc.title,
    jsonLd,
    tags: collectTags(doc),
    canonical: doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
    roles,
  };
}

export function pageMetadata(site: ResolvedSite | null): PageMetadata {
  return extractMetadata(collectPageFacts(site));
}
