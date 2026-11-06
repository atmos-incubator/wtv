/**
 * Content-script side of the playlist runner. One per frame.
 *
 * At start, asks the background whether this page is the current playlist entry. If it
 * is:
 *   - the top frame shows a blackout with the entry title until something plays. If
 *     nothing has played after a few seconds (autoplay blocked, or a player Wtv can't
 *     see), the blackout offers "Start" (the click is a user gesture, so play() is
 *     allowed) and "Next";
 *   - every frame reports its primary's `playing`, `near-end` and `ended` to the runner,
 *     ignoring anything that happens during an ad (YouTube plays ads in the same
 *     <video>, so an ad ending looks like the video ending);
 *   - the entry's `[ads]` program replaces the default for the ad overlay.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import type { MediaAgent } from '../media/agent';
import type { ProgramItem } from '../overlay/program';
import {
  PL_COMMAND,
  PL_HELLO,
  PL_MEDIA,
  parseEntryInfo,
  parsePlaylistApply,
  type EntryInfo,
  type MediaEvent,
} from './messages';

/** Offer "Start" if nothing has played by then. */
const PROMPT_AFTER_MS = 6000;
/** Report near-end this close to the end (YouTube's end screen starts ~20 s out). */
const NEAR_END_S = 20;
/** Treat playback this close to the end as ended (some players stop just short). */
const END_SLACK_S = 0.25;
/** Shorter media isn't the show (and has no meaningful near-end). */
const MIN_SHOW_S = 30;
const WATCH_EVENTS = ['playing', 'ended', 'timeupdate'] as const;

export interface Blackout {
  title: string | null;
  /** Offer Start / Next. */
  prompt: boolean;
}

export interface PlaylistClient {
  /** The current entry's ad program; null = default. */
  ads(): ProgramItem[] | null;
  /** Top frame only. */
  blackout(): Blackout | null;
  onChange(cb: () => void): () => void;
  /** "Start" on the blackout (inside a user gesture). */
  start(): void;
  next(): void;
}

export function startPlaylistClient(ctx: ContentScriptContext, agent: MediaAgent, ads: AdWatcher): PlaylistClient {
  const { signal } = ctx;
  const isTop = window === window.top;
  let entry: EntryInfo | null = null;
  let blackout: Blackout | null = null;
  let promptTimer: ReturnType<typeof setTimeout> | undefined;
  let primaryCleanup: (() => void) | null = null;
  const sent = new Set<MediaEvent>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        console.error('[wtv] playlist listener failed:', err);
      }
    }
  }

  function report(event: MediaEvent): void {
    if (!entry || sent.has(event)) return;
    sent.add(event);
    browser.runtime.sendMessage({ type: PL_MEDIA, gen: entry.gen, event }).catch(() => undefined);
  }

  function showBlackout(title: string | null): void {
    if (!isTop) return;
    blackout = { title, prompt: false };
    if (promptTimer !== undefined) clearTimeout(promptTimer);
    promptTimer = setTimeout(() => {
      promptTimer = undefined;
      if (blackout && !blackout.prompt) {
        blackout = { ...blackout, prompt: true };
        notify();
      }
    }, PROMPT_AFTER_MS);
    notify();
  }

  function lift(): void {
    if (promptTimer !== undefined) clearTimeout(promptTimer);
    promptTimer = undefined;
    if (!blackout) return;
    blackout = null;
    notify();
  }

  const adActive = () => ads.status()?.active ?? false;

  function onMediaEvent(el: HTMLMediaElement, type: string): void {
    if (!entry) return;
    if (type === 'playing') {
      lift();
      report('playing');
      return;
    }
    const d = el.duration;
    if (adActive() || el.loop || !Number.isFinite(d) || d < 1) return;
    if (type === 'ended') {
      report('ended');
      return;
    }
    const left = d - el.currentTime;
    if (d >= MIN_SHOW_S && left <= NEAR_END_S) report('near-end');
    if (el.currentTime > 0 && left <= END_SLACK_S) report('ended');
  }

  function watchPrimary(): void {
    primaryCleanup?.();
    primaryCleanup = null;
    const el = agent.primary()?.element;
    if (!el || !entry) return;
    const controller = new AbortController();
    const opts = { passive: true, signal: AbortSignal.any([signal, controller.signal]) };
    for (const type of WATCH_EVENTS) el.addEventListener(type, () => onMediaEvent(el, type), opts);
    primaryCleanup = () => controller.abort();
    if (!el.paused && !el.ended) onMediaEvent(el, 'playing');
  }

  const offPrimary = agent.onPrimaryChange(watchPrimary);

  const onMessage = (raw: unknown) => {
    const msg = parsePlaylistApply(raw);
    if (!msg || !isTop) return undefined;
    if (msg.op === 'lift') lift();
    else showBlackout(msg.title);
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);

  ctx.onInvalidated(() => {
    browser.runtime.onMessage.removeListener(onMessage);
    offPrimary();
    primaryCleanup?.();
    if (promptTimer !== undefined) clearTimeout(promptTimer);
  });

  browser.runtime
    .sendMessage({ type: PL_HELLO })
    .then((raw: unknown) => {
      entry = parseEntryInfo(raw);
      if (!entry) return;
      showBlackout(entry.title ?? (document.title || location.hostname));
      watchPrimary();
      notify();
    })
    .catch(() => undefined);

  return {
    ads: () => entry?.ads ?? null,
    blackout: () => blackout,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start() {
      agent.primary()?.play();
      lift();
    },
    next() {
      browser.runtime.sendMessage({ type: PL_COMMAND, op: 'next' }).catch(() => undefined);
    },
  };
}
