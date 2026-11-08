/**
 * Card page: where a playlist entry with `view=card` plays. The runner navigates the
 * playlist's tab here (`card.html?gen=N`) instead of to the post's site. Shows the post
 * on a full-screen title card (author, title, text, pictures, time) for `dur=`, or a time
 * from its length.
 *
 * The post comes from the background (PL_POST, through the site's adapter in posts/),
 * never from the site's embed script, and only as text and picture URLs: nothing here is
 * HTML.
 *
 * Click or Space pauses (⏸); the playlist's Next / Previous work as anywhere. A post the
 * site says is gone is reported (the runner shows "Unavailable" and moves on); any other
 * failure is shown for a moment, then the playlist moves on.
 */
import './style.css';
import { browser } from 'wxt/browser';
import { cardDurationS, type Post } from '../../lib/posts/adapters';
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

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const statusLine = $('status');
const card = $('card');
const pausedMark = $('paused');
const progress = $('progress').firstElementChild as HTMLElement;

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

function renderPictures(urls: readonly string[]): void {
  const box = $('pics');
  box.replaceChildren(
    ...urls.map((src) => {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.src = src;
      img.addEventListener(
        'error',
        () => {
          img.remove();
          box.hidden = box.childElementCount === 0;
        },
        { once: true },
      );
      return img;
    }),
  );
  box.dataset.count = String(urls.length);
  box.hidden = urls.length === 0;
}

function render(post: Post): void {
  $('author').textContent = post.author;
  $('handle').textContent = post.handle ?? '';
  const title = $('title');
  title.textContent = post.title ?? '';
  title.hidden = !post.title;
  const text = $('text');
  text.textContent = post.text;
  text.hidden = !post.text;
  text.className = `text ${lengthClass(post.text, (post.title ? 1 : 0) + (post.images.length ? 1 : 0))}`;
  renderPictures(post.images);
  $('site').textContent = post.site;
  $('time').textContent = post.time ?? '';
  document.title = post.author ? `${post.author} · Wtv` : 'Wtv';
  say('');
  card.hidden = false;
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
  say(entry.title ?? 'Loading the post…');
  const result = parsePostResult(await browser.runtime.sendMessage({ type: PL_POST, gen: entry.gen }).catch(() => null));
  if (!result) {
    say('Couldn’t load the post.');
    setTimeout(() => report('ended'), ERROR_DWELL_MS);
    return;
  }
  if (!result.ok) {
    say(result.gone ? `Unavailable: ${entry.title ?? 'this post'}` : result.error);
    if (result.gone) report('gone');
    else setTimeout(() => report('ended'), ERROR_DWELL_MS);
    return;
  }
  render(result.post);
  start(entry.endS ?? cardDurationS(result.post));
}

document.addEventListener('click', () => setPaused(runningSince !== null));
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat) return;
  e.preventDefault();
  setPaused(runningSince !== null);
});

void main();
