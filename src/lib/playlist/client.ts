/**
 * Content-script side of the playlist runner. One per frame.
 *
 * At start, asks the background whether this page is the current playlist entry. If it
 * is:
 *   - the top frame shows a blackout with the entry title until something plays.
 *     Starting playback is Wtv's job here (it's a TV), so once the primary video has
 *     data, the site gets a short grace period to autoplay on its own, then Wtv calls
 *     play() itself, up to a few times. Each try pulses the status line (or the Start
 *     button once it's showing) and says how it went.
 *   - "Start" / "Next" appear when Chrome refuses autoplay (the page hook sees play()
 *     rejected with NotAllowedError, here or in an embedded frame), when Wtv's own tries
 *     fail, or after a long fallback wait with no video at all. A click on Start is a
 *     user gesture, so play() is allowed then;
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
/** Once the video has data, give the site this long to start it before Wtv does. */
const SITE_AUTOPLAY_GRACE_MS = 2000;
/** Gaps before each automatic start attempt. */
const ATTEMPT_DELAYS_MS = [0, 1500, 3000];
/** Bridged media can't report its play() result; check whether it's playing after this. */
const BRIDGED_CHECK_MS = 600;
/** Report near-end this close to the end (YouTube's end screen starts ~20 s out). */
const NEAR_END_S = 20;
/** Treat playback this close to the end as ended (some players stop just short). */
const END_SLACK_S = 0.25;
/** Shorter media isn't the show (and has no meaningful near-end). */
const MIN_SHOW_S = 30;
const WATCH_EVENTS = ['playing', 'ended', 'timeupdate', 'loadeddata', 'canplay'] as const;

export interface Blackout {
  title: string | null;
  /** Offer Start / Next. */
  prompt: boolean;
  /** Automatic start attempts so far (each one pulses the Start button). */
  attempt: number;
  /** How the last attempt went. */
  status: string | null;
}

type Trigger = 'blocked' | 'blocked-in-frame' | 'timeout' | 'ready';

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
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let attempting = false;
  /** The blackout is for this page's entry (not the one shown while leaving a page). */
  let awaitingStart = false;
  let primaryCleanup: (() => void) | null = null;
  const sent = new Set<MediaEvent>();
  const adActive = () => ads.status()?.active ?? false;
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
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    promptTimer = attemptTimer = graceTimer = undefined;
  }

  /** `forEntry`: this page is the entry (from hello), so Wtv should get it playing. */
  function showBlackout(title: string | null, forEntry: boolean): void {
    if (!isTop) return;
    clearTimers();
    attempting = false;
    awaitingStart = forEntry;
    blackout = { title, prompt: false, attempt: 0, status: null };
    if (forEntry) {
      promptTimer = setTimeout(() => {
        promptTimer = undefined;
        trigger('timeout');
      }, FALLBACK_PROMPT_MS);
    }
    notify();
  }

  function lift(): void {
    clearTimers();
    attempting = false;
    awaitingStart = false;
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
      update({ attempt: blackout.attempt + 1, status: `Starting the video… (${i + 1} of ${n})` });
      void tryPlay().then((result) => {
        console.info(`[wtv] playlist start attempt ${i + 1}/${n}: ${result}`);
        if (!blackout) return; // Lifted: something played.
        if (result === 'playing') {
          lift();
          return;
        }
        const last = i + 1 >= n;
        // A refusal won't change by itself: show Start / Next now.
        update({
          prompt: blackout.prompt || last || result === 'blocked',
          status: `${REASONS[result]}. ${last ? 'Click Start.' : 'Trying again…'}`,
        });
        if (!last) attempt(i + 1);
      });
    }, ATTEMPT_DELAYS_MS[i]);
  }

  /**
   * Time for Wtv to start playback itself. `ready`: the video has data and the site
   * didn't start it (no buttons unless the tries fail). Anything else is a problem, so
   * Start / Next show right away.
   */
  function trigger(why: Trigger): void {
    if (!blackout || !awaitingStart) return;
    if (promptTimer !== undefined) clearTimeout(promptTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    promptTimer = graceTimer = undefined;
    if (why === 'blocked-in-frame') {
      // We can't retry inside another frame; the user has to click its player.
      update({ prompt: true, status: 'Chrome blocked autoplay in the embedded player. Click Start, then its ▶.' });
      return;
    }
    if (why === 'blocked') update({ prompt: true, status: 'Chrome blocked autoplay.' });
    else if (why === 'timeout') update({ prompt: true });
    if (attempting) return;
    attempting = true;
    attempt(0);
  }

  /** The primary has data but isn't playing: start the grace period before we start it. */
  function considerStarting(): void {
    if (!isTop || !blackout || !awaitingStart || attempting || graceTimer !== undefined) return;
    if (adActive()) return; // The site's ad flow decides what plays now.
    const primary = agent.primary();
    if (!primary) return;
    const f = primary.features(null);
    if (f.playing || !f.hasSource) return;
    const el = primary.element;
    if (el && el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return; // Wait for loadeddata.
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (!primary.features(null).playing) trigger('ready');
    }, SITE_AUTOPLAY_GRACE_MS);
  }

  function onMediaEvent(el: HTMLMediaElement, type: string): void {
    if (!entry) return;
    if (type === 'playing') {
      lift();
      report('playing');
      return;
    }
    if (type === 'loadeddata' || type === 'canplay') {
      considerStarting();
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
    else considerStarting();
  }

  const offPrimary = agent.onPrimaryChange(watchPrimary);

  const onMessage = (raw: unknown) => {
    const msg = parsePlaylistApply(raw);
    if (!msg || !isTop) return undefined;
    if (msg.op === 'lift') lift();
    else if (msg.op === 'blocked') trigger('blocked-in-frame');
    else if (msg.op === 'blackout') showBlackout(msg.title, false);
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
      showBlackout(entry.title ?? (document.title || location.hostname), true);
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
