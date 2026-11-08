/**
 * Posts as title cards (playlist entries with `view=card`). One small adapter per site
 * turns a post URL into a `Post`, from a public endpoint that needs no sign-in. Pure:
 * the background fetches (fetch.ts), the card page renders (entrypoints/card). Never a
 * site's embed script.
 *
 *   - X / Twitter: the public oEmbed endpoint (`publish.x.com/oembed`), which returns the
 *     post's text, author and date as a small blockquote of HTML. Parsed here with
 *     regular expressions (the background has no DOM); only text comes out of it.
 *
 * More sites (Bluesky, Mastodon, Reddit) are one adapter each.
 */

export interface Post {
  /** The site's name, for the card ("X"). */
  site: string;
  author: string;
  /** "@handle", if the site has them. */
  handle: string | null;
  text: string;
  /** As the site words it ("May 5, 2014"). */
  time: string | null;
  /** The post's canonical URL. */
  url: string;
  /** Picture URLs, when the site's endpoint gives them. */
  images: string[];
}

export interface PostAdapter {
  id: string;
  site: string;
  /** Hosts the background fetches from: asked for at Play, never given content scripts. */
  fetchHosts: readonly string[];
  /** The canonical post URL, or null if this isn't one of the site's posts. */
  canonical(url: URL): string | null;
  /** What the background fetches for a canonical post URL. */
  endpoint(canonical: string): string;
  parse(json: unknown, canonical: string): Post | null;
}

const MAX_TEXT = 5000;

// --- HTML scraps --------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Tags out, line breaks kept, entities decoded, whitespace tidied. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/[ \t\f\v]+/g, ' '),
  )
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- X / Twitter -----------------------------------------------------------------------

const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
const X_STATUS = /^\/(?:([A-Za-z0-9_]{1,15})|i\/web)\/status(?:es)?\/(\d{1,25})(?:\/|$)/;

/** X's oEmbed: the post as `<blockquote><p>text</p>&mdash; Name (@handle) <a>date</a></blockquote>`. */
export function parseXOembed(json: unknown, canonical: string): Post | null {
  if (typeof json !== 'object' || json === null) return null;
  const { html, author_name, author_url } = json as Record<string, unknown>;
  if (typeof html !== 'string') return null;
  const body = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  if (body === undefined) return null;
  // Media links (pic.x.com / pic.twitter.com) mean nothing on a card.
  const withoutMedia = body.replace(/<a\b[^>]*>\s*pic\.(?:twitter|x)\.com\/[^<]*<\/a>/gi, '');
  const text = htmlToText(withoutMedia).slice(0, MAX_TEXT);
  const time = /<a\b[^>]*>([^<]*)<\/a>\s*<\/blockquote>/i.exec(html)?.[1];
  const handle = typeof author_url === 'string' ? /\/([A-Za-z0-9_]{1,15})\/?$/.exec(author_url)?.[1] : undefined;
  const author = typeof author_name === 'string' && author_name.trim() ? decodeEntities(author_name.trim()) : (handle ?? '');
  if (!author && !text) return null;
  return {
    site: 'X',
    author,
    handle: handle ? `@${handle}` : null,
    text,
    time: time ? decodeEntities(time).trim() || null : null,
    url: canonical,
    images: [],
  };
}

export const X_ADAPTER: PostAdapter = {
  id: 'x',
  site: 'X',
  fetchHosts: ['publish.x.com'],
  canonical(url) {
    if (!X_HOSTS.test(url.hostname)) return null;
    const m = X_STATUS.exec(url.pathname);
    if (!m) return null;
    return `https://x.com/${m[1] ?? 'i/web'}/status/${m[2]}`;
  },
  endpoint(canonical) {
    return `https://publish.x.com/oembed?url=${encodeURIComponent(canonical)}&omit_script=1&dnt=true`;
  },
  parse: parseXOembed,
};

export const POST_ADAPTERS: readonly PostAdapter[] = [X_ADAPTER];

/** The sites `view=card` works on, for messages ("X (x.com)"). */
export const POST_SITES = 'X (x.com)';

export function findPostAdapter(url: string): { adapter: PostAdapter; canonical: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  for (const adapter of POST_ADAPTERS) {
    const canonical = adapter.canonical(u);
    if (canonical) return { adapter, canonical };
  }
  return null;
}

/** The hosts to fetch these posts from (for the permission request at Play). */
export function postFetchHosts(urls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const url of urls) for (const h of findPostAdapter(url)?.adapter.fetchHosts ?? []) out.add(h);
  return [...out].sort();
}

/** Every adapter's fetch hosts: these never get content scripts. */
export const ALL_POST_FETCH_HOSTS: readonly string[] = [...new Set(POST_ADAPTERS.flatMap((a) => a.fetchHosts))];

// --- the card ---------------------------------------------------------------------------

export const CARD_MIN_S = 8;
export const CARD_MAX_S = 45;

/** How long a card stays up without `dur=`: time to read it twice over, roughly. */
export function cardDurationS(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(CARD_MAX_S, Math.max(CARD_MIN_S, Math.round(6 + words * 0.4)));
}

/** "Name: the first words of the post…", for the media library. */
export function postTitle(post: Post): string {
  const line = post.text.replace(/\s+/g, ' ').trim();
  const short = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  return short ? `${post.author}: ${short}` : post.author;
}

export function parsePost(raw: unknown): Post | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
  const author = str(p.author, 300);
  const text = str(p.text, MAX_TEXT);
  const url = str(p.url, 2000);
  if (author === null || text === null || !url || !/^https?:\/\//i.test(url)) return null;
  return {
    site: str(p.site, 50) ?? '',
    author,
    handle: str(p.handle, 50),
    text,
    time: str(p.time, 100),
    url,
    images: Array.isArray(p.images)
      ? p.images.filter((i): i is string => typeof i === 'string' && /^https:\/\//i.test(i)).slice(0, 4)
      : [],
  };
}
