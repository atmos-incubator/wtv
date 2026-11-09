/**
 * Read a post from its own page with the site's post selectors (content script, DOM).
 * For `view=card` entries whose site has them (posts/source.ts), and for the side
 * panel's card preview while picking them.
 *
 * Only text and picture URLs come out, like the adapters; the card page renders them.
 * The `postEmbed` role is different: it's the element itself (findPostEmbed), lifted in
 * place over the card (posts/embed.ts), never copied out.
 */
import { deepQueryAll, isShown, matchRoleShownFirst } from '../dom/query';
import type { ResolvedSite } from '../sites/overrides';
import type { Matcher, PostRoleName } from '../sites/schema';
import { MAX_IMAGES, formatDate, type Post } from './adapters';

const MAX_TEXT = 5000;
const MAX_LINE = 300;
/** Smaller than this on screen: an avatar, an emoji, an icon. */
const MIN_PICTURE_PX = 64;

/** What one role of the post reads, for the side panel's test line. */
export interface PostField {
  role: PostRoleName;
  value: string | null;
}

function lines(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textOf(el: Element): string {
  if (el instanceof HTMLMetaElement) return el.content.trim();
  return lines(el instanceof HTMLElement ? el.innerText : (el.textContent ?? ''));
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);

/** A <time datetime> (the element or inside it) → "May 5, 2014"; else what it says. */
function timeOf(el: Element): string | null {
  const stamp =
    el.getAttribute('datetime') ??
    el.querySelector('time[datetime]')?.getAttribute('datetime') ??
    (el instanceof HTMLMetaElement ? el.content : null);
  return formatDate(stamp) ?? (oneLine(textOf(el)) || null);
}

function pictureUrls(el: Element): string[] {
  const imgs = el instanceof HTMLImageElement ? [el] : [...el.querySelectorAll('img')];
  const out: string[] = [];
  for (const img of imgs) {
    const r = img.getBoundingClientRect();
    if (img.complete && r.width > 0 && (r.width < MIN_PICTURE_PX || r.height < MIN_PICTURE_PX)) continue;
    out.push(img.currentSrc || img.src);
  }
  const video = el instanceof HTMLVideoElement ? el : el.querySelector('video');
  if (video?.poster) out.push(video.poster);
  if (el instanceof HTMLMetaElement) out.push(el.content);
  return out;
}

/** Absolute https URLs only. */
function httpsUrl(u: string): string | null {
  try {
    const url = new URL(u, location.href);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** What one post role's element reads (the side panel's test line). */
export function postFieldValue(role: PostRoleName, el: Element): string {
  switch (role) {
    case 'post':
      return oneLine(textOf(el)).slice(0, 120);
    case 'postTitle':
    case 'postAuthor':
      return oneLine(textOf(el));
    case 'postText':
      return textOf(el).slice(0, MAX_TEXT);
    case 'postTime':
      return timeOf(el) ?? '';
    case 'postImage':
      return pictureUrls(el)
        .map(httpsUrl)
        .filter((u): u is string => u !== null)
        .join('\n');
    case 'postEmbed':
      return describeEmbed(el);
  }
}

/** The first <iframe> in `el` or its open shadow roots. */
function frameInside(el: Element): HTMLIFrameElement | null {
  const roots: (Element | ShadowRoot)[] = [el];
  for (let root = roots.shift(); root; root = roots.shift()) {
    const found = root.querySelector('iframe');
    if (found) return found;
    if (root instanceof Element && root.shadowRoot) roots.push(root.shadowRoot);
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) roots.push(host.shadowRoot);
  }
  return null;
}

/**
 * What to lift for a picked embed: the element if it's a player (<iframe>, <video>);
 * else the <iframe> inside it (its size is the site's, in pixels, so lifting the box
 * around it wouldn't make it bigger); else the element (a site's own player element).
 */
export function embedTarget(el: Element): HTMLElement | null {
  if (el instanceof HTMLIFrameElement || el instanceof HTMLVideoElement) return el;
  return frameInside(el) ?? (el instanceof HTMLElement ? el : null);
}

function describeEmbed(el: Element): string {
  const target = embedTarget(el);
  if (!target) return '';
  if (target instanceof HTMLIFrameElement) {
    try {
      return `an embedded player from ${new URL(target.src).hostname}`;
    } catch {
      return 'an embedded player';
    }
  }
  return target instanceof HTMLVideoElement ? 'a video' : `<${target.localName}>`;
}

/** The post's embedded player (the `postEmbed` role), in the post's box first. Null if none on screen. */
export function findPostEmbed(site: ResolvedSite): HTMLElement | null {
  const matchers = site.config.roles.postEmbed;
  if (!matchers?.length) return null;
  const roles = site.config.roles;
  const box = roles.post?.length ? matchRoleShownFirst('post', roles.post) : null;
  const el = (box ? matchRoleShownFirst('postEmbed', matchers, box) : null) ?? matchRoleShownFirst('postEmbed', matchers);
  return el ? embedTarget(el) : null;
}

export function readPagePost(site: ResolvedSite, pageUrl: string = location.href): { post: Post | null; fields: PostField[] } {
  const roles = site.config.roles;
  // On screen first: an app keeps the posts you navigated away from in the page, hidden.
  const box = roles.post?.length ? matchRoleShownFirst('post', roles.post) : null;

  /** In the post's box first, then anywhere (a forum's thread title sits outside it). */
  const find = (role: PostRoleName): Element | null => {
    const matchers = roles[role];
    if (!matchers?.length) return null;
    return (box ? matchRoleShownFirst(role, matchers, box) : null) ?? matchRoleShownFirst(role, matchers);
  };

  const titleEl = find('postTitle');
  const authorEl = find('postAuthor');
  const textEl = find('postText');
  const timeEl = find('postTime');
  const title = titleEl ? oneLine(textOf(titleEl)) || null : null;
  const author = authorEl ? oneLine(textOf(authorEl)) : '';
  const text = textEl ? textOf(textEl).slice(0, MAX_TEXT) : '';
  const time = timeEl ? timeOf(timeEl) : null;
  const images = postPictures(roles.postImage ?? [], box);
  const embedEl = find('postEmbed');
  const embed = embedEl ? describeEmbed(embedEl) || null : null;

  const fields: PostField[] = [
    { role: 'post', value: box ? oneLine(textOf(box)).slice(0, 120) || '(no text)' : null },
    { role: 'postTitle', value: title },
    { role: 'postAuthor', value: author || null },
    { role: 'postText', value: text || null },
    { role: 'postTime', value: time },
    { role: 'postImage', value: images.length ? images.join('\n') : null },
    { role: 'postEmbed', value: embed },
  ];
  // A picture or a player is a post too (no caption: the card is all picture).
  if (!title && !text && images.length === 0 && !embed) return { post: null, fields };
  return {
    post: {
      site: site.config.name,
      author,
      handle: null,
      title,
      text,
      time,
      url: pageUrl.split('#')[0] ?? pageUrl,
      images,
    },
    fields,
  };
}

/**
 * The first matcher that finds pictures: in the post's box first, then anywhere, like the
 * other roles (the box picked may be just the text's: Bluesky's pictures sit beside it).
 */
function postPictures(matchers: readonly Matcher[], box: Element | null): string[] {
  for (const root of box ? [box, document] : [document]) {
    for (const m of matchers) {
      const found = deepQueryAll(m.selector, root).elements;
      // The ones on screen, if any: not an earlier post the app keeps hidden.
      const shown = found.filter(isShown);
      const elements = shown.length ? shown : found;
      const urls = [...new Set(elements.flatMap(pictureUrls).map(httpsUrl).filter((u): u is string => u !== null))];
      if (urls.length) return urls.slice(0, MAX_IMAGES);
    }
  }
  return [];
}
