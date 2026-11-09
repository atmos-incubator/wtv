/**
 * Posts as title cards (playlist entries with `view=card`). One small adapter per site
 * turns a post URL into a `Post`, from a public endpoint that needs no sign-in. Pure:
 * the background fetches (fetch.ts), the card page renders (entrypoints/card). Never a
 * site's embed script.
 *
 *   - X / Twitter: the public oEmbed endpoint (`publish.x.com/oembed`), which returns the
 *     post's text, author and date as a small blockquote of HTML.
 *   - Reddit: the post's Atom feed (`<post>/.rss`), the one public read endpoint Reddit
 *     still serves without sign-in (its `.json` asks for a login). The post is the feed's
 *     first entry; its body comes as escaped HTML.
 *   - Bluesky: the public AppView API (`public.api.bsky.app`,
 *     `app.bsky.feed.getPostThread`), plain JSON, open to cross-origin requests.
 *
 * HTML from the sites is read with regular expressions (the background has no DOM), and
 * only text and picture URLs come out of it.
 *
 * No imports, on purpose: the health check (scripts/health, Node type stripping) imports
 * this file directly to judge posts the way the extension does.
 */

export interface Post {
  /** The site's name, for the card ("X"). */
  site: string;
  author: string;
  /** "@handle", or where it was posted ("r/pics"). */
  handle: string | null;
  /** The post's own title, on sites that have them (Reddit). */
  title: string | null;
  text: string;
  /** As the site words it ("May 5, 2014"). */
  time: string | null;
  /** The post's canonical URL. */
  url: string;
  /** Picture URLs (https), when the site's endpoint gives them. */
  images: string[];
}

/** A `view=card` entry's post. `gone`: the site says it doesn't exist (any more). */
export type PostResult = { ok: true; post: Post } | { ok: false; gone: boolean; error: string };

export interface PostAdapter {
  id: string;
  site: string;
  /** Hosts the background fetches from that need host access (no CORS): asked for at Play. */
  fetchHosts: readonly string[];
  /** Hosts that serve only the endpoint, never pages: they never get content scripts. */
  apiHosts: readonly string[];
  /** The canonical post URL, or null if this isn't one of the site's posts. */
  canonical(url: URL): string | null;
  /** What the background fetches for a canonical post URL. */
  endpoint(canonical: string): string;
  /** The endpoint's answer (status, body) → the post, or why not. */
  read(status: number, body: string, canonical: string): PostResult;
}

const MAX_TEXT = 5000;
const MAX_TITLE = 500;
export const MAX_IMAGES = 4;

const failed = (error: string, gone = false): PostResult => ({ ok: false, gone, error });
const unreadable = (site: string) => failed(`Couldn’t read ${site}’s answer`);
const gone = (site: string) => failed(`${site} says this post isn’t available`, true);

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** An ISO time → "May 5, 2014" (the viewer's time zone). */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

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

/** Tags out, line and paragraph breaks kept, list items bulleted, entities decoded. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(?:p|div|h[1-6]|blockquote|pre|ul|ol|table|tr)\s*>/gi, '\n\n')
      .replace(/<hr\b[^>]*>/gi, '\n\n')
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
export function parseXOembed(raw: unknown, canonical: string): Post | null {
  if (!isObj(raw)) return null;
  const { html, author_name, author_url } = raw;
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
    title: null,
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
  apiHosts: ['publish.x.com'],
  canonical(url) {
    if (!X_HOSTS.test(url.hostname)) return null;
    const m = X_STATUS.exec(url.pathname);
    if (!m) return null;
    return `https://x.com/${m[1] ?? 'i/web'}/status/${m[2]}`;
  },
  endpoint(canonical) {
    return `https://publish.x.com/oembed?url=${encodeURIComponent(canonical)}&omit_script=1&dnt=true`;
  },
  read(status, body, canonical) {
    // Deleted, or private (protected accounts): it won't play either way.
    if (status === 404 || status === 410 || status === 403) return gone('X');
    if (status < 200 || status >= 300) return failed(`X answered ${status}`);
    const post = parseXOembed(json(body), canonical);
    return post ? { ok: true, post } : unreadable('X');
  },
};

// --- Reddit ------------------------------------------------------------------------------

const REDDIT_HOSTS = /^(?:www\.|old\.|new\.|np\.|m\.|amp\.)?reddit\.com$/i;
const REDDIT_POST = /^\/(?:(?:r|u|user)\/([A-Za-z0-9_-]{2,21})\/)?comments\/([a-z0-9]{1,12})(?:\/|$)/i;
/** Where Reddit keeps pictures: anything else in a feed is left alone. */
const REDDIT_IMAGE_HOSTS = /^(?:i|preview|external-preview)\.redd\.it$|^[a-z]\.thumbs\.redditmedia\.com$|^i\.imgur\.com$/i;

function redditImage(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw));
    return u.protocol === 'https:' && REDDIT_IMAGE_HOSTS.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The post's Atom feed: the post is the first `<entry>` (`t3_` id), its comments follow.
 * The entry's content is escaped HTML: the post's own text between `<!-- SC_OFF -->` and
 * `<!-- SC_ON -->` (self posts), then Reddit's "submitted by … [link] [comments]" line,
 * whose [link] is the picture for picture posts.
 */
export function parseRedditFeed(xml: string, canonical: string): PostResult {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry || !/<id>t3_[a-z0-9]+<\/id>/i.test(entry)) return unreadable('Reddit');
  const field = (re: RegExp) => {
    const v = re.exec(entry)?.[1];
    return v === undefined ? null : decodeEntities(v).trim();
  };
  const title = field(/<title>([\s\S]*?)<\/title>/);
  const author = field(/<author>\s*<name>([\s\S]*?)<\/name>/)?.replace(/^\/u\//, 'u/') ?? null;
  const sub = field(/<category\b[^>]*\blabel="([^"]*)"/);
  const html = decodeEntities(/<content\b[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] ?? '');
  const self = /<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/.exec(html)?.[1];
  const text = self ? htmlToText(self).slice(0, MAX_TEXT) : '';
  if (text === '[deleted]' || text === '[removed]') return gone('Reddit');
  if (!title && !text) return unreadable('Reddit');

  // The [link] when it's a picture, else the preview in the content, else the thumbnail.
  const linked = /<a href="([^"]+)">\[link\]<\/a>/.exec(html)?.[1];
  const image =
    (linked && /\.(?:jpe?g|png|gif|webp)$/i.test(decodeEntities(linked).split('?')[0]!) ? redditImage(linked) : null) ??
    redditImage(/<img\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1]) ??
    redditImage(/<media:thumbnail\b[^>]*\burl="([^"]+)"/.exec(entry)?.[1]);

  return {
    ok: true,
    post: {
      site: 'Reddit',
      author: author || 'u/[deleted]',
      handle: sub || null,
      title: title ? title.slice(0, MAX_TITLE) : null,
      text,
      time: formatDate(field(/<published>([^<]*)<\/published>/)),
      url: canonical,
      images: image ? [image] : [],
    },
  };
}

export const REDDIT_ADAPTER: PostAdapter = {
  id: 'reddit',
  site: 'Reddit',
  fetchHosts: ['www.reddit.com'],
  // www.reddit.com is a site people watch, too: it keeps its content scripts.
  apiHosts: [],
  canonical(url) {
    if (url.hostname.toLowerCase() === 'redd.it') {
      const id = /^\/([a-z0-9]{1,12})\/?$/i.exec(url.pathname)?.[1];
      return id ? `https://www.reddit.com/comments/${id.toLowerCase()}/` : null;
    }
    if (!REDDIT_HOSTS.test(url.hostname)) return null;
    const m = REDDIT_POST.exec(url.pathname);
    if (!m) return null;
    const where = m[1] && /^\/r\//i.test(url.pathname) ? `r/${m[1]}/` : '';
    return `https://www.reddit.com/${where}comments/${m[2]!.toLowerCase()}/`;
  },
  endpoint(canonical) {
    return `${canonical}.rss?limit=1`;
  },
  read(status, body, canonical) {
    if (status === 404 || status === 410) return gone('Reddit');
    if (status === 429) return failed('Reddit is limiting requests: try again in a minute');
    if (status === 403) return failed('Reddit refused (a private community, or it’s blocking requests from here)');
    if (status < 200 || status >= 300) return failed(`Reddit answered ${status}`);
    return parseRedditFeed(body, canonical);
  },
};

// --- Bluesky -------------------------------------------------------------------------------

const BSKY_HOSTS = /^(?:www\.)?bsky\.app$/i;
const BSKY_POST = /^\/profile\/((?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z0-9-]{1,63}|did:(?:plc|web):[A-Za-z0-9._:%-]{1,200})\/post\/([A-Za-z0-9._:~-]{1,512})\/?$/;
/** Labels Bluesky hides pictures behind for signed-out viewers. */
const BSKY_ADULT = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore']);

const labelValues = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((l) => (isObj(l) && typeof l.val === 'string' ? [l.val] : [])) : [];

function httpsUrl(v: unknown): string | null {
  return typeof v === 'string' && /^https:\/\//i.test(v) ? v : null;
}

/** Pictures from a post's embed view: images, a video's poster, a link card's picture. */
function bskyImages(embed: unknown): string[] {
  if (!isObj(embed)) return [];
  const type = str(embed.$type) ?? '';
  if (type === 'app.bsky.embed.images#view' && Array.isArray(embed.images)) {
    return embed.images.flatMap((i) => (isObj(i) ? [httpsUrl(i.fullsize) ?? httpsUrl(i.thumb)].filter((u): u is string => !!u) : []));
  }
  if (type === 'app.bsky.embed.video#view') return [httpsUrl(embed.thumbnail)].filter((u): u is string => !!u);
  if (type === 'app.bsky.embed.external#view' && isObj(embed.external)) {
    return [httpsUrl(embed.external.thumb)].filter((u): u is string => !!u);
  }
  if (type === 'app.bsky.embed.recordWithMedia#view') return bskyImages(embed.media);
  return [];
}

/** `getPostThread`'s answer (depth 0): `{ thread: { $type, post: { author, record, embed, labels } } }`. */
export function parseBlueskyThread(raw: unknown, canonical: string): PostResult {
  const thread = isObj(raw) && isObj(raw.thread) ? raw.thread : null;
  if (!thread) return unreadable('Bluesky');
  const type = str(thread.$type);
  if (type === 'app.bsky.feed.defs#notFoundPost' || type === 'app.bsky.feed.defs#blockedPost') return gone('Bluesky');
  const post = isObj(thread.post) ? thread.post : null;
  const author = post && isObj(post.author) ? post.author : null;
  const record = post && isObj(post.record) ? post.record : null;
  if (!post || !author || !record) return unreadable('Bluesky');
  // Authors can ask to be seen only by signed-in people. The public API still answers,
  // but it's anonymous, so Wtv doesn't show these from it. Read from bsky.app itself
  // (post selectors: posts/source.ts), the page is the user's own signed-in session.
  if (labelValues(author.labels).includes('!no-unauthenticated')) {
    return failed(
      'This author’s Bluesky posts are for signed-in people only. To show them signed in, open a Bluesky post and pick its post selectors (Fix selectors → Posts).',
    );
  }
  const handle = str(author.handle);
  const name = str(author.displayName)?.trim() || handle || '';
  const text = (str(record.text) ?? '').trim().slice(0, MAX_TEXT);
  const adult = labelValues(post.labels).some((l) => BSKY_ADULT.has(l));
  const images = adult ? [] : bskyImages(post.embed).slice(0, MAX_IMAGES);
  if (!name && !text && images.length === 0) return unreadable('Bluesky');
  return {
    ok: true,
    post: {
      site: 'Bluesky',
      author: name,
      handle: handle && handle !== 'handle.invalid' ? `@${handle}` : null,
      title: null,
      text,
      time: formatDate(str(record.createdAt)),
      url: canonical,
      images,
    },
  };
}

export const BLUESKY_ADAPTER: PostAdapter = {
  id: 'bluesky',
  site: 'Bluesky',
  // The public API allows cross-origin requests: no host access to ask for.
  fetchHosts: [],
  apiHosts: ['public.api.bsky.app'],
  canonical(url) {
    if (!BSKY_HOSTS.test(url.hostname)) return null;
    const m = BSKY_POST.exec(url.pathname);
    if (!m) return null;
    const actor = m[1]!.startsWith('did:') ? m[1]! : m[1]!.toLowerCase();
    return `https://bsky.app/profile/${actor}/post/${m[2]}`;
  },
  endpoint(canonical) {
    const m = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([^/]+)$/.exec(canonical);
    const uri = m ? `at://${m[1]}/app.bsky.feed.post/${m[2]}` : '';
    return `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`;
  },
  read(status, body, canonical) {
    const answer = json(body);
    // A missing post (or an unknown handle) is a 400 with `{ error: "NotFound" }`.
    if (status === 404 || (status === 400 && isObj(answer) && answer.error === 'NotFound')) return gone('Bluesky');
    if (status < 200 || status >= 300) return failed(`Bluesky answered ${status}`);
    return parseBlueskyThread(answer, canonical);
  },
};

// --- all sites ---------------------------------------------------------------------------

export const POST_ADAPTERS: readonly PostAdapter[] = [X_ADAPTER, REDDIT_ADAPTER, BLUESKY_ADAPTER];

/** The sites `view=card` works on, for messages. */
export const POST_SITES = 'X, Reddit and Bluesky';

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

/** The hosts these posts need host access to (for the permission request at Play). */
export function postFetchHosts(urls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const url of urls) for (const h of findPostAdapter(url)?.adapter.fetchHosts ?? []) out.add(h);
  return [...out].sort();
}

/** Every adapter's endpoint-only hosts: these never get content scripts. */
export const ALL_POST_API_HOSTS: readonly string[] = [...new Set(POST_ADAPTERS.flatMap((a) => a.apiHosts))];

// --- the card ---------------------------------------------------------------------------

export const CARD_MIN_S = 8;
export const CARD_MAX_S = 45;

/** How long a card stays up without `dur=`: time to read it twice over, roughly, and look at its pictures. */
export function cardDurationS(post: Pick<Post, 'title' | 'text' | 'images'>): number {
  const words = `${post.title ?? ''} ${post.text}`.split(/\s+/).filter(Boolean).length;
  const pictures = Math.min(MAX_IMAGES, post.images.length) * 3;
  return Math.min(CARD_MAX_S, Math.max(CARD_MIN_S, Math.round(6 + words * 0.4 + pictures)));
}

/** "Name: the first words of the post…", for the media library. */
export function postTitle(post: Post): string {
  const line = (post.title ?? post.text).replace(/\s+/g, ' ').trim();
  const short = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  if (!post.author) return short;
  return short ? `${post.author}: ${short}` : post.author;
}

export function parsePost(raw: unknown): Post | null {
  if (!isObj(raw)) return null;
  const p = raw;
  const cut = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
  const author = cut(p.author, 300);
  const text = cut(p.text, MAX_TEXT);
  const url = cut(p.url, 2000);
  if (author === null || text === null || !url || !/^https?:\/\//i.test(url)) return null;
  return {
    site: cut(p.site, 50) ?? '',
    author,
    handle: cut(p.handle, 50),
    title: cut(p.title, MAX_TITLE),
    text,
    time: cut(p.time, 100),
    url,
    images: Array.isArray(p.images)
      ? p.images.filter((i): i is string => typeof i === 'string' && /^https:\/\//i.test(i)).slice(0, MAX_IMAGES)
      : [],
  };
}
