/**
 * Page metadata (title, creator, description, keywords, thumbnail, duration) from what a
 * page says about itself. Pure: works on `PageFacts`, which page.ts collects from the DOM.
 *
 * Order per field (first value wins; every value found is kept for the side panel preview):
 *   1. The user's own selector for the role (an override saved in the side panel).
 *   2. JSON-LD (`VideoObject` first, then other media / article types).
 *   3. OpenGraph (`og:*`, `video:*`, `article:*`).
 *   4. Other meta tags: `name=` (`description`, `keywords`, `author`, `twitter:*`) and
 *      microdata (`itemprop`).
 *   5. The site config's selector for the role.
 *   6. `document.title` (title only).
 *
 * Stale data: single-page apps (YouTube) keep the first page's `<head>` after in-app
 * navigation. When `og:url` (else `<link rel=canonical>`) names a different page than the
 * one showing, every OpenGraph and `name=` tag is ignored. A JSON-LD item whose `url` is
 * another page on the same site is ignored too (one on another site describes an
 * embedded video, which is fine).
 */
import { sameEntryUrl } from '../playlist/match';

export const META_FIELDS = ['title', 'creator', 'description', 'keywords', 'thumbnail', 'duration'] as const;
export type MetaField = (typeof META_FIELDS)[number];

/** Fields that have a selector role of the same name. */
export const META_ROLES = ['title', 'creator', 'description', 'keywords'] as const;
export type MetaRole = (typeof META_ROLES)[number];

export type MetaSource = 'yours' | 'jsonld' | 'opengraph' | 'meta' | 'selector' | 'page';

export const META_SOURCE_LABELS: Record<MetaSource, string> = {
  yours: 'your selector',
  jsonld: 'JSON-LD',
  opengraph: 'OpenGraph',
  meta: 'meta tags',
  selector: 'site selector',
  page: 'page title',
};

/** A `<meta>` / `<link>` value. `key` is lowercase: `og:title`, `description`, `itemprop:author.name`. */
export interface MetaTag {
  key: string;
  value: string;
}

export interface PageFacts {
  url: string;
  documentTitle: string;
  /** Text of each `<script type="application/ld+json">`. */
  jsonLd: string[];
  tags: MetaTag[];
  canonical: string | null;
  /** What each metadata role's selectors read, and whether they're the user's own. */
  roles: Partial<Record<MetaRole, { value: string; yours: boolean }>>;
}

export interface MetaCandidate {
  source: MetaSource;
  /** Where exactly: `og:title`, `VideoObject.name`, ... */
  detail: string;
  /** As text; keywords joined with ", ", duration in seconds. */
  value: string;
}

export interface PageMetadata {
  title: string | null;
  creator: string | null;
  description: string | null;
  keywords: string[];
  /** Absolute http(s) URL. */
  thumbnail: string | null;
  /** Seconds. */
  duration: number | null;
  sources: Partial<Record<MetaField, MetaSource>>;
  /** Every value found per field, winner first. */
  candidates: Record<MetaField, MetaCandidate[]>;
  /** The page's OpenGraph / meta tags describe another page and were ignored. */
  staleHead: boolean;
}

const MAX_TEXT = 2000;
const MAX_KEYWORDS = 50;

// --- text helpers ----------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Some sites HTML-escape the strings inside their JSON-LD. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function cleanText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/** ISO 8601 duration (`PT4M13S`, `P1DT2H`) or plain seconds → seconds. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(t);
  if (!m || t.length < 3 || /T$/i.test(t)) return null;
  const [, d, h, min, s] = m.map((v) => (v === undefined ? 0 : Number(v)));
  const total = (d ?? 0) * 86400 + (h ?? 0) * 3600 + (min ?? 0) * 60 + (s ?? 0);
  return Number.isFinite(total) ? total : null;
}

function absoluteUrl(value: string, base: string): string | null {
  try {
    const u = new URL(value.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function splitKeywords(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    for (const part of v.split(',')) {
      const k = cleanText(part);
      if (!k || seen.has(k.toLowerCase())) continue;
      seen.add(k.toLowerCase());
      out.push(k);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
}

// --- JSON-LD ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** In preference order. VideoObject first; the rest cover other media and articles. */
const LD_TYPES = [
  'VideoObject',
  'Movie',
  'TVEpisode',
  'Episode',
  'Clip',
  'MusicVideoObject',
  'MusicRecording',
  'PodcastEpisode',
  'AudioObject',
  'NewsArticle',
  'Article',
  'BlogPosting',
  'SocialMediaPosting',
];

const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function types(node: Json): string[] {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^https?:\/\/schema\.org\//, ''));
}

/** Every typed object in the JSON-LD, including nested ones (`@graph`, `mainEntity`, `video`). */
function ldNodes(texts: readonly string[]): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || out.length > 200) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isJson(v)) {
      if (types(v).length > 0) out.push(v);
      for (const x of Object.values(v)) if (typeof x === 'object') walk(x, depth + 1);
    }
  };
  for (const text of texts) {
    try {
      walk(JSON.parse(text), 0);
    } catch {
      // Broken JSON-LD is common; skip it.
    }
  }
  return out;
}

function sameSite(a: string, b: string): boolean {
  try {
    const host = (u: string) => new URL(u).hostname.toLowerCase().replace(/^(www|m)\./, '');
    return host(a) === host(b);
  } catch {
    return false;
  }
}

function pickLdNode(texts: readonly string[], pageUrl: string): { node: Json; type: string } | null {
  const nodes = ldNodes(texts).filter((n) => {
    const own = typeof n.url === 'string' ? absoluteUrl(n.url, pageUrl) : null;
    return !own || !sameSite(own, pageUrl) || sameEntryUrl(pageUrl, own);
  });
  for (const type of LD_TYPES) {
    const node = nodes.find((n) => types(n).includes(type));
    if (node) return { node, type };
  }
  return null;
}

/** Text of a JSON-LD value: a string, a number, `{ name }`, `{ @value }`, or a list of those. */
function ldText(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (typeof v === 'number') return [String(v)];
  if (Array.isArray(v)) return v.flatMap(ldText);
  if (isJson(v)) {
    for (const key of ['name', '@value']) if (typeof v[key] === 'string') return [v[key] as string];
  }
  return [];
}

function ldUrl(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(ldUrl);
  if (isJson(v)) {
    for (const key of ['url', 'contentUrl']) if (typeof v[key] === 'string') return [v[key] as string];
  }
  return [];
}

// --- extraction ------------------------------------------------------------------------

function sourceOfTag(key: string): MetaSource {
  return /^(og|video|article|music|book|profile):/.test(key) ? 'opengraph' : 'meta';
}

/** Tag keys per field, in order. `itemprop:` keys come from microdata. */
const TAG_KEYS: Record<MetaField, string[]> = {
  title: ['og:title', 'twitter:title', 'title', 'itemprop:name', 'itemprop:headline'],
  creator: ['author', 'itemprop:author.name', 'article:author', 'itemprop:author'],
  description: ['og:description', 'twitter:description', 'description', 'itemprop:description'],
  keywords: ['og:video:tag', 'video:tag', 'article:tag', 'keywords', 'itemprop:keywords'],
  thumbnail: ['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'itemprop:thumbnailurl', 'itemprop:image'],
  duration: ['og:video:duration', 'video:duration', 'itemprop:duration'],
};

const LD_KEYS: Record<MetaField, string[]> = {
  title: ['name', 'headline'],
  creator: ['author', 'creator', 'byArtist', 'director'],
  description: ['description'],
  keywords: ['keywords'],
  thumbnail: ['thumbnailUrl', 'image'],
  duration: ['duration'],
};

/** Whether the page's head (OpenGraph, `name=` tags) describes the page that's showing. */
export function headIsStale(facts: Pick<PageFacts, 'url' | 'tags' | 'canonical'>): boolean {
  const ogUrl = facts.tags.find((t) => t.key === 'og:url')?.value ?? null;
  const claimed = ogUrl ?? facts.canonical;
  if (!claimed) return false;
  const abs = absoluteUrl(claimed, facts.url);
  return abs !== null && !sameEntryUrl(facts.url, abs);
}

/** Normalize one raw value for a field; null if it isn't usable. */
function normalize(field: MetaField, raw: string, pageUrl: string): string | null {
  switch (field) {
    case 'thumbnail':
      return absoluteUrl(decodeEntities(raw), pageUrl);
    case 'duration': {
      const s = parseDuration(raw);
      return s !== null && s > 0 ? String(s) : null;
    }
    case 'keywords': {
      const k = splitKeywords([raw]);
      return k.length > 0 ? k.join(', ') : null;
    }
    case 'creator':
      // `article:author` and microdata `author` are often profile URLs, not names.
      return /^https?:\/\//i.test(raw.trim()) ? null : cleanText(raw) || null;
    default:
      return cleanText(raw) || null;
  }
}

export function extractMetadata(facts: PageFacts): PageMetadata {
  const staleHead = headIsStale(facts);
  const ld = pickLdNode(facts.jsonLd, facts.url);
  const tags = staleHead ? facts.tags.filter((t) => t.key.startsWith('itemprop:')) : facts.tags;

  const candidates = Object.fromEntries(META_FIELDS.map((f) => [f, [] as MetaCandidate[]])) as Record<
    MetaField,
    MetaCandidate[]
  >;
  const add = (field: MetaField, source: MetaSource, detail: string, raw: string) => {
    const value = normalize(field, raw, facts.url);
    if (value !== null) candidates[field].push({ source, detail, value });
  };

  for (const field of META_FIELDS) {
    const role = (META_ROLES as readonly string[]).includes(field) ? facts.roles[field as MetaRole] : undefined;
    if (role?.yours) add(field, 'yours', 'your selector', role.value);

    if (ld) {
      for (const key of LD_KEYS[field]) {
        const values = field === 'thumbnail' ? ldUrl(ld.node[key]) : ldText(ld.node[key]);
        if (values.length === 0) continue;
        // Lists: keywords and creators are joined, a list of thumbnails gives its first.
        const raw = field === 'keywords' || field === 'creator' ? values.join(', ') : values[0]!;
        add(field, 'jsonld', `${ld.type}.${key}`, raw);
        break;
      }
    }

    for (const key of TAG_KEYS[field]) {
      const values = tags.filter((t) => t.key === key).map((t) => t.value);
      if (values.length === 0) continue;
      // `og:video:tag` / `article:tag` repeat once per keyword.
      add(field, sourceOfTag(key), key.replace(/^itemprop:/, 'itemprop '), field === 'keywords' ? values.join(',') : values[0]!);
    }

    if (role && !role.yours) add(field, 'selector', 'site selector', role.value);
    if (field === 'title') add(field, 'page', 'document.title', facts.documentTitle.replace(/^\(\d+\+?\)\s*/, ''));
  }

  // Duplicate values (og:title = twitter:title) add nothing to the preview.
  for (const field of META_FIELDS) {
    const seen = new Set<string>();
    candidates[field] = candidates[field].filter((c) => {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });
  }

  const first = (field: MetaField) => candidates[field][0] ?? null;
  const sources: PageMetadata['sources'] = {};
  for (const field of META_FIELDS) {
    const c = first(field);
    if (c) sources[field] = c.source;
  }
  const keywords = first('keywords');
  const duration = first('duration');
  return {
    title: first('title')?.value ?? null,
    creator: first('creator')?.value ?? null,
    description: first('description')?.value ?? null,
    keywords: keywords ? splitKeywords([keywords.value]) : [],
    thumbnail: first('thumbnail')?.value ?? null,
    duration: duration ? Number(duration.value) : null,
    sources,
    candidates,
    staleHead,
  };
}
