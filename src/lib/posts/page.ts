/**
 * Read a post from its own page with the site's post selectors (content script, DOM).
 * For `view=card` entries whose site has them (posts/source.ts), and for the side
 * panel's card preview while picking them.
 *
 * Only text and picture URLs come out, like the adapters; the card page renders them.
 */
import { deepQueryAll, matchRole } from '../dom/query';
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
  }
}

export function readPagePost(site: ResolvedSite, pageUrl: string = location.href): { post: Post | null; fields: PostField[] } {
  const roles = site.config.roles;
  const box = roles.post?.length ? matchRole('post', roles.post).match?.element ?? null : null;

  /** In the post's box first, then anywhere (a forum's thread title sits outside it). */
  const find = (role: PostRoleName): Element | null => {
    const matchers = roles[role];
    if (!matchers?.length) return null;
    return (box ? matchRole(role, matchers, box).match?.element : null) ?? matchRole(role, matchers).match?.element ?? null;
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

  const fields: PostField[] = [
    { role: 'post', value: box ? oneLine(textOf(box)).slice(0, 120) || '(no text)' : null },
    { role: 'postTitle', value: title },
    { role: 'postAuthor', value: author || null },
    { role: 'postText', value: text || null },
    { role: 'postTime', value: time },
    { role: 'postImage', value: images.length ? images.join('\n') : null },
  ];
  if (!title && !text) return { post: null, fields };
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

/** The first matcher that finds pictures (in the post's box when there is one). */
function postPictures(matchers: readonly Matcher[], box: Element | null): string[] {
  for (const m of matchers) {
    const { elements } = deepQueryAll(m.selector, box ?? document);
    const urls = [...new Set(elements.flatMap(pictureUrls).map(httpsUrl).filter((u): u is string => u !== null))];
    if (urls.length) return urls.slice(0, MAX_IMAGES);
  }
  return [];
}
