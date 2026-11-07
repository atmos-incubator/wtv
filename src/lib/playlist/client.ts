/**
 * Content-script side of the playlist runner. One per frame.
 *
 * At start, asks the background whether this page is the current playlist entry. The
 * top frame doesn't wait for the answer if the URL has a `#wtv:` hash (hash.ts): it
 * blacks out at document_start, before the page paints, and takes the start time from
 * the hash; the hash is then removed from the address bar (one-shot). A `#wtv:` link
 * outside any playlist gets the same treatment: blackout, start, seek. A hash arriving
 * later (`hashchange`: the runner moved to an entry on the same page) starts over.
 *
 * For an entry:
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
 *   - every frame with a primary video seeks it to the entry's start time (`t=`) once
 *     that's safe (seek.ts: after metadata, never during an ad);
 *   - at the entry's end time (`end=` / `dur=`, or the hash's `e=`) the media pauses and,
 *     in a playlist, reports `ended`. An end time without a start time starts from 0, so a
 *     site resuming where the viewer left off can't skip past it;
 *   - the entry's `[ads]` program replaces the default for the ad overlay, and
 *     `view=pictures` entries have their `[show]` program cover the media throughout.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import type { MediaAgent } from '../media/agent';
import { EVT_BLOCKED } from '../media/protocol';
import { parseWtvHash, stripWtvHash, type WtvHash } from './hash';
import { endState, seekDecision } from './seek';
import type { PlayResult } from '../media/registry';
import type { ProgramItem } from '../overlay/program';
import type { ViewMode } from './format';
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
const WATCH_EVENTS = [
  'playing',
  'ended',
  'timeupdate',
  'loadedmetadata',
  'durationchange',
  'loadeddata',
  'canplay',
] as const;

export interface Blackout {
  title: string | null;
  /** Offer Start / Next. */
  prompt: boolean;
  /** Automatic start attempts so far (each one pulses the Start button). */
  attempt: number;
  /** How the last attempt went. */
  status: string | null;
  /** There's a playlist to skip ahead in (not for a stand-alone #wtv: link). */
  canNext: boolean;
}

type Trigger = 'blocked' | 'blocked-in-frame' | 'timeout' | 'ready';

export interface PlaylistClient {
  /** The current entry's ad program; null = default. */
  ads(): ProgramItem[] | null;
  /** How the current entry is shown (`video` outside a playlist). */
  view(): ViewMode;
  /** The current entry's pictures for `view: pictures`; null = the site's images. */
  show(): ProgramItem[] | null;
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
  /** This page was opened with a #wtv: hash. */
  let fromHash = false;
  /** Where to seek to, from the entry (source of truth) or the hash. */
  let startS: number | null = null;
  /** Where to stop, from the entry or the hash. */
  let endS: number | null = null;
  /** Paused at the end time already (once: the viewer may play on). */
  let endDone = false;
  let seekDone = false;
  /** Since when the primary has been playing with no ad showing (ms epoch), else null. */
  let cleanSince: number | null = null;
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
    blackout = { title, prompt: false, attempt: 0, status: null, canNext: entry !== null };
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

  const active = () => entry !== null || fromHash;

  function trySeek(el: HTMLMediaElement): void {
    if (seekDone || startS === null) return;
    const ad = adActive();
    if (ad || el.paused) cleanSince = null;
    else cleanSince ??= Date.now();
    const decision = seekDecision({
      startS,
      currentTime: el.currentTime,
      duration: el.duration,
      readyState: el.readyState,
      adActive: ad,
      adsInMainVideo: Boolean(agent.profile().site?.config.quirks?.adsInMainVideo),
      playingForMs: cleanSince === null ? 0 : Date.now() - cleanSince,
    });
    if (decision === 'wait') return;
    seekDone = true;
    if (decision === 'seek') {
      console.info(`[wtv] seeking to the entry's start time, ${startS}s`);
      el.currentTime = startS;
    }
  }

  function onMediaEvent(el: HTMLMediaElement, type: string): void {
    if (!active()) return;
    trySeek(el);
    if (type === 'playing') {
      lift();
      report('playing');
      return;
    }
    if (type === 'loadeddata' || type === 'canplay') {
      considerStarting();
      return;
    }
    if (adActive() || el.loop) return;
    if (type === 'ended') {
      if (Number.isFinite(el.duration) && el.duration >= 1) report('ended');
      return;
    }
    const state = endState({
      currentTime: el.currentTime,
      duration: el.duration,
      endS: endDone ? null : endS,
      seekDone,
    });
    if (state === 'end-time') {
      endDone = true;
      console.info(`[wtv] reached the end time, ${endS}s`);
      el.pause();
      report('ended');
    } else if (state) {
      report(state);
    }
  }

  function watchPrimary(): void {
    primaryCleanup?.();
    primaryCleanup = null;
    const el = agent.primary()?.element;
    if (!el || !active()) return;
    const controller = new AbortController();
    const opts = { passive: true, signal: AbortSignal.any([signal, controller.signal]) };
    for (const type of WATCH_EVENTS) el.addEventListener(type, () => onMediaEvent(el, type), opts);
    primaryCleanup = () => controller.abort();
    trySeek(el);
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
      if (!active()) return;
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

  // An ad starting or ending changes whether it's safe to seek.
  const offAd = ads.onAdChange(() => {
    const el = agent.primary()?.element;
    if (el && active()) trySeek(el);
  });
  ctx.onInvalidated(offAd);

  /** Top frame: read (and remove) a #wtv: hash. */
  function takeHash(): WtvHash | null {
    if (!isTop) return null;
    const hash = parseWtvHash(location.hash);
    if (!hash) return null;
    try {
      // Before the page's own scripts read the URL; keeps reloads and copied links plain.
      history.replaceState(history.state, '', stripWtvHash(location.href));
    } catch {
      // Sandboxed or opaque origin: leave it.
    }
    return hash;
  }

  function begin(hash: WtvHash | null): void {
    entry = null;
    fromHash = hash !== null;
    endS = hash?.end ?? null;
    startS = hash?.t ?? (endS !== null ? 0 : null);
    endDone = false;
    seekDone = false;
    cleanSince = null;
    sent.clear();
    if (hash) {
      showBlackout(hash.title ?? location.hostname, true);
      watchPrimary();
    }
    browser.runtime
      .sendMessage({ type: PL_HELLO })
      .then((raw: unknown) => {
        entry = parseEntryInfo(raw);
        if (!entry) return;
        endS = entry.endS;
        startS = entry.startS ?? (endS !== null ? 0 : null);
        if (hash && blackout) update({ canNext: true, title: entry.title ?? blackout.title });
        else showBlackout(entry.title ?? (document.title || location.hostname), true);
        watchPrimary();
        notify();
      })
      .catch(() => undefined);
  }

  window.addEventListener(
    'hashchange',
    () => {
      const hash = takeHash();
      if (hash) begin(hash);
    },
    { signal },
  );

  begin(takeHash());

  return {
    ads: () => entry?.ads ?? null,
    view: () => entry?.view ?? 'video',
    show: () => entry?.show ?? null,
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
