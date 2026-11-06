/**
 * Content-script side of the playlist runner. One per frame.
 *
 * At start, asks the background whether this page is the current playlist entry. If it
 * is:
 *   - the top frame shows a blackout with the entry title until something plays. When
 *     Chrome refuses autoplay (the page hook sees play() rejected with NotAllowedError,
 *     here or in an embedded frame), or nothing has played after a long fallback wait,
 *     the blackout offers "Start" (a click there is a user gesture, so play() is
 *     allowed) and "Next", and Wtv tries play() itself a few times. Each try pulses the
 *     Start button and the status line says how it went (blocked / no video yet /
 *     didn't start), which tells "too early" apart from "refused";
 *   - every frame reports its primary's `playing`, `near-end` and `ended` to the runner,
 *     ignoring anything that happens during an ad (YouTube plays ads in the same
 *     <video>, so an ad ending looks like the video ending);
 *   - the entry's `[ads]` program replaces the default for the ad overlay.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import type { MediaAgent } from '../media/agent';
import { EVT_BLOCKED } from '../media/protocol';
import type { PlayResult } from '../media/registry';
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

/** Offer "Start" if nothing has played (and nothing was refused) by then. */
const FALLBACK_PROMPT_MS = 15_000;
/** Gaps before each automatic start attempt. */
const ATTEMPT_DELAYS_MS = [500, 1500, 3000];
/** Bridged media can't report its play() result; check whether it's playing after this. */
const BRIDGED_CHECK_MS = 600;
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
  /** Automatic start attempts so far (each one pulses the Start button). */
  attempt: number;
  /** How the last attempt went. */
  status: string | null;
}

type Trigger = 'blocked' | 'blocked-in-frame' | 'timeout';

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
  let attemptTimer: ReturnType<typeof setTimeout> | undefined;
  let attempting = false;
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

  function update(patch: Partial<Blackout>): void {
    if (!blackout) return;
    blackout = { ...blackout, ...patch };
    notify();
  }

  function clearTimers(): void {
    if (promptTimer !== undefined) clearTimeout(promptTimer);
    if (attemptTimer !== undefined) clearTimeout(attemptTimer);
    promptTimer = attemptTimer = undefined;
  }

  function showBlackout(title: string | null): void {
    if (!isTop) return;
    clearTimers();
    attempting = false;
    blackout = { title, prompt: false, attempt: 0, status: null };
    promptTimer = setTimeout(() => {
      promptTimer = undefined;
      trigger('timeout');
    }, FALLBACK_PROMPT_MS);
    notify();
  }

  function lift(): void {
    clearTimers();
    attempting = false;
    if (!blackout) return;
    blackout = null;
    notify();
  }

  async function tryPlay(): Promise<PlayResult | 'no-media'> {
    const primary = agent.primary();
    if (!primary) return 'no-media';
    const result = await primary.play();
    if (result !== 'unknown') return result;
    await new Promise((r) => setTimeout(r, BRIDGED_CHECK_MS));
    return primary.features(null).playing ? 'playing' : 'failed';
  }

  const REASONS: Record<Exclude<PlayResult, 'playing'> | 'no-media', string> = {
    blocked: 'Chrome blocked autoplay',
    'no-media': 'No video on the page yet',
    failed: 'The video didn’t start',
    unknown: 'The video didn’t start',
  };

  function attempt(i: number): void {
    attemptTimer = setTimeout(() => {
      attemptTimer = undefined;
      if (!blackout) return;
      const n = ATTEMPT_DELAYS_MS.length;
      update({ attempt: blackout.attempt + 1, status: `Trying to start… (${i + 1} of ${n})` });
      void tryPlay().then((result) => {
        console.info(`[wtv] playlist start attempt ${i + 1}/${n}: ${result}`);
        if (!blackout) return; // Lifted: something played.
        if (result === 'playing') {
          lift();
          return;
        }
        const last = i + 1 >= n;
        update({ status: `${REASONS[result]}. ${last ? 'Click Start.' : 'Trying again…'}` });
        if (!last) attempt(i + 1);
      });
    }, ATTEMPT_DELAYS_MS[i]);
  }

  /** Something's in the way of playback: offer Start / Next, and try a few times ourselves. */
  function trigger(why: Trigger): void {
    if (!blackout) return;
    if (promptTimer !== undefined) clearTimeout(promptTimer);
    promptTimer = undefined;
    if (why === 'blocked-in-frame') {
      // We can't retry inside another frame; the user has to click its player.
      update({ prompt: true, status: 'Chrome blocked autoplay in the embedded player. Click Start, then its ▶.' });
      return;
    }
    update({ prompt: true, status: why === 'blocked' ? 'Chrome blocked autoplay.' : null });
    if (attempting) return;
    attempting = true;
    attempt(0);
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
    else if (msg.op === 'blocked') trigger('blocked-in-frame');
    else if (msg.op === 'blackout') showBlackout(msg.title);
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);

  // The page's own play() was refused by the autoplay policy.
  document.addEventListener(
    EVT_BLOCKED,
    () => {
      if (!entry) return;
      if (isTop) trigger('blocked');
      else report('blocked');
    },
    { capture: true, signal },
  );

  ctx.onInvalidated(() => {
    browser.runtime.onMessage.removeListener(onMessage);
    offPrimary();
    primaryCleanup?.();
    clearTimers();
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
      // Inside the click on Start: the user activation reaches this page, so play() is allowed.
      void agent.primary()?.play();
      lift();
    },
    next() {
      browser.runtime.sendMessage({ type: PL_COMMAND, op: 'next' }).catch(() => undefined);
    },
  };
}
