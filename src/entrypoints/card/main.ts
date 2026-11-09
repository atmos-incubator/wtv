/**
 * Card page: where a playlist entry with `view=card` plays. The runner navigates the
 * playlist's tab here (`card.html?gen=N`) instead of to the post's site. Shows the post
 * on a full-screen title card (author, title, text, pictures, time) for `dur=`, or a time
 * from its length. Pictures are loaded first, for their shapes: tall ones usually go down
 * the side, wide ones under the text (layOutPictures, posts/card-layout.ts).
 *
 * The post comes from the background (PL_POST, through the site's adapter in posts/),
 * never from the site's embed script, and only as text and picture URLs: nothing here is
 * HTML.
 *
 * `?embed`: framed over the post's own page instead (posts/embed.ts), whose embedded
 * player is lifted into the slot this page leaves empty beside the post (embed-layout.ts).
 * No pictures then (the player is the picture), and it shows for at least a minute.
 *
 * While the post loads, one of the ad pictures shows (the entry's `[ads]`, else the
 * library's), like the blackout on other entries.
 *
 * Click or Space pauses (⏸); the playlist's Next / Previous work as anywhere. A post the
 * site says is gone is reported (the runner shows "Unavailable" and moves on); any other
 * failure is shown for a moment, then the playlist moves on.
 */
import './style.css';
import { browser } from 'wxt/browser';
import { cardDurationS, type Post } from '../../lib/posts/adapters';
import { getImageBlob } from '../../lib/images/db';
import { loadingPicture, rememberLoadingPicture } from '../../lib/images/loading-picture';
import { createImageResolver } from '../../lib/images/resolver';
import { fitMode } from '../../lib/overlay/fit';
import { DEFAULT_AD_ITEMS, buildSlides, type ProgramItem } from '../../lib/overlay/program';
import { planCard } from '../../lib/posts/card-layout';
import { embedCardDurationS, embedLayout, type Box } from '../../lib/posts/embed-layout';
import {
  PL_HELLO,
  PL_MEDIA,
  PL_POST,
  parseEntryInfo,
  parsePostResult,
  type EntryInfo,
  type MediaEvent,
} from '../../lib/playlist/messages';

/** A failure stays on screen this long before the next entry. */
const ERROR_DWELL_MS = 8000;
/** Wait this long at most for the pictures' shapes before showing the card. */
const PICTURE_WAIT_MS = 3000;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const statusLine = $('status');
const card = $('card');
const pausedMark = $('paused');
const progress = $('progress').firstElementChild as HTMLElement;
/** Framed over the post's page, beside its embedded player. */
const embedded = new URLSearchParams(location.search).has('embed');

function put(el: HTMLElement, box: Box): void {
  Object.assign(el.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
}

function layOut(): void {
  const { slot, text } = embedLayout(window.innerWidth, window.innerHeight);
  put($('slot'), slot);
  put(card, text);
}

window.addEventListener('resize', () => {
  if (pictures.length) layOutPictures();
});

if (embedded) {
  document.documentElement.classList.add('embedded');
  $('slot').hidden = false;
  layOut();
  window.addEventListener('resize', layOut, { passive: true });
}

let entry: EntryInfo | null = null;
let totalMs = 0;
/** Time shown so far, not counting pauses. */
let shownMs = 0;
let runningSince: number | null = null;
let done = false;
let tick: ReturnType<typeof setInterval> | undefined;
let raf = 0;

function report(event: MediaEvent): void {
  if (!entry) return;
  browser.runtime.sendMessage({ type: PL_MEDIA, gen: entry.gen, event }).catch(() => undefined);
}

function say(text: string): void {
  statusLine.textContent = text;
  statusLine.hidden = !text;
  if (text) hidePoster();
}

// --- the loading picture -------------------------------------------------------------

const poster = $('poster');
let posterDone = false;
let posterUrl: string | null = null;

/**
 * One ad picture over the whole page until the post (or why not) is ready: the one the
 * loading screen before this page showed, if that was moments ago (images/loading-picture.ts).
 */
async function showPoster(items: readonly ProgramItem[]): Promise<void> {
  try {
    let slide = loadingPicture();
    if (!slide) {
      const resolve = await createImageResolver('');
      const first = buildSlides(items, resolve).find((s) => s.kind === 'img') ?? buildSlides(DEFAULT_AD_ITEMS, resolve)[0];
      slide = first?.kind === 'img' ? first : null;
    }
    if (!slide || posterDone) return;
    rememberLoadingPicture(slide);
    let url: string;
    if (slide.src.type === 'url') {
      url = slide.src.url;
    } else {
      const blob = await getImageBlob(slide.src.id);
      if (!blob || posterDone) return;
      url = posterUrl = URL.createObjectURL(blob);
    }
    const media = slide.isVideo
      ? Object.assign(document.createElement('video'), { src: url, muted: true, loop: true, autoplay: true, playsInline: true })
      : Object.assign(document.createElement('img'), { src: url, alt: '' });
    const fit = () => {
      const [w, h] = media instanceof HTMLVideoElement ? [media.videoWidth, media.videoHeight] : [media.naturalWidth, media.naturalHeight];
      media.style.objectFit = fitMode(w, h, window.innerWidth, window.innerHeight);
    };
    media.addEventListener(media instanceof HTMLVideoElement ? 'loadedmetadata' : 'load', fit, { once: true });
    poster.replaceChildren(media);
    poster.hidden = false;
  } catch (err) {
    console.warn('[wtv] no loading picture:', err);
  }
}

function hidePoster(): void {
  posterDone = true;
  poster.hidden = true;
  poster.replaceChildren();
  if (posterUrl) URL.revokeObjectURL(posterUrl);
  posterUrl = null;
}

const elapsed = () => shownMs + (runningSince === null ? 0 : performance.now() - runningSince);

function frame(): void {
  if (done || !entry) return;
  const ms = elapsed();
  progress.style.transform = `scaleX(${Math.min(1, ms / totalMs)})`;
  if (ms >= totalMs) {
    done = true;
    clearInterval(tick);
    cancelAnimationFrame(raf);
    report('ended');
  }
}

/** Smooth progress while running and visible; the 1 s timer covers hidden tabs. */
function loop(): void {
  frame();
  raf = !done && runningSince !== null ? requestAnimationFrame(loop) : 0;
}

function setPaused(paused: boolean): void {
  if (done || !totalMs || paused === (runningSince === null)) return;
  if (paused) {
    shownMs = elapsed();
    runningSince = null;
  } else {
    runningSince = performance.now();
    if (!raf) loop();
  }
  pausedMark.hidden = !paused;
  document.documentElement.classList.toggle('paused', paused);
}

const SIZES = ['short', 'medium', 'long', 'longer'] as const;

/** Type size by length; a step smaller when there's a title or pictures to fit too. */
function lengthClass(text: string, crowded: number): string {
  const step = text.length <= 80 ? 0 : text.length <= 200 ? 1 : text.length <= 450 ? 2 : 3;
  return SIZES[Math.min(SIZES.length - 1, step + crowded)]!;
}

interface Picture {
  src: string;
  /** Width ÷ height; null until it has loaded. */
  aspect: number | null;
}

let pictures: Picture[] = [];

/** Load the pictures to learn their shapes, for at most PICTURE_WAIT_MS. Broken ones are dropped. */
async function loadPictures(urls: readonly string[]): Promise<Picture[]> {
  const broken = new Set<Picture>();
  const all = urls.map((src) => {
    const pic: Picture = { src, aspect: null };
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const done = new Promise<void>((resolve) => {
      img.onload = () => {
        pic.aspect = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
        resolve();
        // Arrived after the card was laid out: again, with its real shape.
        if (pictures.includes(pic)) layOutPictures();
      };
      img.onerror = () => {
        broken.add(pic);
        resolve();
        if (pictures.includes(pic)) {
          pictures = pictures.filter((p) => p !== pic);
          layOutPictures();
        }
      };
    });
    img.src = src;
    return { pic, done };
  });
  await Promise.race([Promise.all(all.map((a) => a.done)), new Promise((r) => setTimeout(r, PICTURE_WAIT_MS))]);
  // Still loading: kept, as a square until it arrives.
  return all.map((a) => a.pic).filter((p) => !broken.has(p));
}

/**
 * Pick the layout for the pictures' shapes and the card's size (card-layout.ts): `stack`
 * (text above, pictures below) or `side` (pictures down the left, text beside them), and
 * rows of pictures that fill their area. Again on resize, and as late pictures load.
 */
function layOutPictures(): void {
  const box = $('pics');
  card.classList.remove('stack', 'side');
  card.classList.toggle('with-pics', pictures.length > 0);
  if (pictures.length === 0) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const style = getComputedStyle(card);
  const pad = (a: string, b: string) => parseFloat(style.getPropertyValue(a)) + parseFloat(style.getPropertyValue(b));
  const aspects = pictures.map((p) => p.aspect ?? 1);
  const hasText = Boolean($('title').textContent || $('text').textContent);
  const plan = planCard(
    { width: card.clientWidth - pad('padding-left', 'padding-right'), height: card.clientHeight - pad('padding-top', 'padding-bottom') },
    aspects,
    hasText,
  );
  if (!plan) return;
  card.classList.add(plan.layout);
  const block = document.createElement('div');
  block.className = 'pics-block';
  block.style.setProperty('--ratio', String(plan.ratio));
  for (const row of plan.rows) {
    const line = document.createElement('div');
    line.className = 'pics-row';
    // Rows share the block's width; each is as tall as its pictures' shapes allow.
    line.style.flexGrow = String(1 / row.reduce((sum, i) => sum + aspects[i]!, 0));
    for (const i of row) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.src = pictures[i]!.src;
      img.style.flexGrow = String(aspects[i]);
      line.append(img);
    }
    block.append(line);
  }
  box.replaceChildren(block);
}

function render(post: Post, pics: Picture[]): void {
  $('author').textContent = post.author;
  $('handle').textContent = post.handle ?? '';
  const title = $('title');
  title.textContent = post.title ?? '';
  title.hidden = !post.title;
  const text = $('text');
  text.textContent = post.text;
  text.hidden = !post.text;
  text.className = `text ${lengthClass(post.text, (post.title ? 1 : 0) + (pics.length || embedded ? 1 : 0))}`;
  $('site').textContent = post.site;
  $('time').textContent = post.time ?? '';
  document.title = post.author ? `${post.author} · Wtv` : 'Wtv';
  say('');
  card.hidden = false;
  // Measured now that it's on the page; before the next paint, so no jump.
  pictures = pics;
  layOutPictures();
}

function start(durS: number): void {
  totalMs = durS * 1000;
  shownMs = 0;
  runningSince = performance.now();
  loop();
  // rAF stops in a hidden tab; the timer keeps the playlist moving.
  tick = setInterval(frame, 1000);
  report('playing');
}

async function main(): Promise<void> {
  say('');
  entry = parseEntryInfo(await browser.runtime.sendMessage({ type: PL_HELLO }).catch(() => null));
  if (!entry) {
    say('Nothing to show: this page shows posts from a Wtv playlist.');
    return;
  }
  void showPoster(entry.ads ?? DEFAULT_AD_ITEMS);
  const result = parsePostResult(await browser.runtime.sendMessage({ type: PL_POST, gen: entry.gen }).catch(() => null));
  if (!result) {
    say('Couldn’t load the post.');
    setTimeout(() => report('ended'), ERROR_DWELL_MS);
    return;
  }
  if (!result.ok) {
    // Say why, either way: "unavailable" alone doesn't help fix a playlist.
    say(result.gone ? `Unavailable: ${entry.title ?? 'this post'}\n${result.error}` : result.error);
    if (result.gone) report('gone');
    else setTimeout(() => report('ended'), ERROR_DWELL_MS);
    return;
  }
  // Embedded player: it is the picture.
  const pics = embedded ? [] : await loadPictures(result.post.images);
  hidePoster();
  render(result.post, pics);
  start(entry.endS ?? (embedded ? embedCardDurationS(result.post) : cardDurationS(result.post)));
}

document.addEventListener('click', () => setPaused(runningSince !== null));
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat) return;
  e.preventDefault();
  setPaused(runningSince !== null);
});

void main();
