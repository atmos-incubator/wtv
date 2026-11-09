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
 *   - once the primary has played 3 s with no ad, the frame tells the runner what it knows
 *     about the entry for the media library: the media's duration, and in the top frame
 *     the page metadata (title, creator, thumbnail). A top frame with no player of its
 *     own (an embed page) sends the page metadata after 8 s instead;
 *   - until then, every frame looks for the site's `unavailable` role once a second and
 *     reports `gone` if it shows (the runner shows "Unavailable" and moves on);
 *   - the entry's `[ads]` program replaces the default for the ad overlay, and
 *     `view=pictures` entries have their `[show]` program cover the media throughout.
 *
 * A page shown as a page (`view=read` / `view=scroll`, or a hash with `v=`) has no media
 * to wait for: the top frame keeps the blackout up until the page has loaded, pauses any
 * media on it, then
 *   - read: hands a snapshot of the page to the overlay, which finds the article and
 *     scrolls it at a reading pace (overlay/, Readability), or says there's none, and
 *     then the page is scrolled instead;
 *   - scroll: scrolls the page itself (page-show/scroller.ts).
 * Either way the frame reports `playing`, the page's metadata with the show's length,
 * and `ended` when it's done. Media events are ignored in every frame meanwhile.
 *
 * A post's page read for its card (`view=card` from a site with post selectors, or a
 * hash with `v=card`): the blackout stays up while the top frame reads the post with the
 * site's post selectors (posts/page.ts), trying for a while (apps render late), and
 * sends it, or why not, to the runner (PL_PAGE_POST), which moves on to the card page.
 * A post with an embedded player (the site's `postEmbed` role) stays: the card page is
 * framed over it here, and the player lifted beside the post (posts/embed.ts).
 *
 * A `view=video` entry whose page has no player Wtv can see, but has the site's
 * `postEmbed` (a player embedded from a site Wtv doesn't run on): once the page has
 * loaded and nothing has played for a few seconds, the embed is lifted to fill the tab
 * and the blackout goes. Nothing reports when it ends, so it plays for `dur=` (or a
 * minute), unless Wtv turns out to run inside it after all and reports for itself.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import type { MediaAgent } from '../media/agent';
import { isElementVisible, matchRole } from '../dom/query';
import { EVT_BLOCKED } from '../media/protocol';
import { pageMetadata } from '../metadata/page';
import { parseWtvHash, stripWtvHash, type WtvHash } from './hash';
import { endState, seekDecision } from './seek';
import type { PlayResult } from '../media/registry';
import type { ProgramItem } from '../overlay/program';
import { isPageView, type ViewMode } from './format';
import type { HashView } from './hash';
import { DEFAULT_SCROLL_PX_S, DEFAULT_WPM, scrollDurationS } from '../page-show/pace';
import { startScroller, type Scroller } from '../page-show/scroller';
import { MAX_READ_HTML } from '../overlay/program';
import {
  PL_COMMAND,
  PL_HELLO,
  PL_INFO,
  PL_MEDIA,
  PL_PAGE_POST,
  parseEntryInfo,
  parsePlaylistApply,
  type EntryInfo,
  type MediaEvent,
  type MediaInfo,
  type PostResult,
} from './messages';
import { findPostEmbed, readPagePost } from '../posts/page';
import { cardFrame, showEmbed, type EmbedShow } from '../posts/embed';
import { createNavArrows, type NavArrows } from './nav-arrows';
import { EMBED_DEFAULT_S } from '../posts/embed-layout';
import { hasPostSelectors } from '../sites/schema';
import { unavailableMatchers } from '../sites/gone-markers';

/** Offer "Start" if nothing has played (and nothing was refused) by then. */
const FALLBACK_PROMPT_MS = 15_000;
/** Once the video has data, give the site this long to start it before Wtv does. */
const SITE_AUTOPLAY_GRACE_MS = 2000;
/** Gaps before each automatic start attempt. */
const ATTEMPT_DELAYS_MS = [0, 1500, 3000];
/** Bridged media can't report its play() result; check whether it's playing after this. */
const BRIDGED_CHECK_MS = 600;
/** Tell the runner about the entry once it's played this long with no ad. */
const INFO_AFTER_MS = 3000;
/** Top frame with no player of its own (the player is embedded): send the page metadata after this. */
const INFO_FALLBACK_MS = 8000;
/** A page show starts once the page has loaded, or after this at most. */
const PAGE_LOAD_MAX_MS = 12_000;
/** Then this long more, for late content (lazy images, web fonts, client-side rendering). */
const PAGE_SETTLE_MS = 1200;
/** Look for the `unavailable` role this often, for this long after the entry starts (until it plays). */
const GONE_POLL_MS = 1000;
/** A post's page: how long to look for the post, and how often. */
const POST_WAIT_MS = 15_000;
const POST_POLL_MS = 500;
/** Once found, read again after this, for what was still loading (pictures). */
const POST_SETTLE_MS = 800;
const GONE_WATCH_MS = 60_000;
/** `view=video` with nothing playing this long after the page loaded: show the post's embed, if it has one. */
const EMBED_WAIT_MS = 4000;
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
  /** A notice ("Unavailable: …"): the title is the point. Otherwise loading: ad pictures, no title. */
  notice: boolean;
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

/** A page show in progress (top frame): what the overlay should do about it. */
export type PageShow =
  /** The overlay shows the article (or says there's none). */
  | { kind: 'read'; id: number; url: string; html: string; wpm: number; durS: number | null }
  /** The page itself is the show: nothing over it. */
  | { kind: 'scroll'; id: number };

/** From the overlay, about a `read` page show. */
export type PageEvent =
  | { type: 'started'; id: number; durationS: number }
  | { type: 'failed'; id: number }
  | { type: 'done'; id: number };

export interface PlaylistClient {
  /** The current entry's ad program; null = default. */
  ads(): ProgramItem[] | null;
  /** How the current entry is shown (`video` outside a playlist). */
  view(): ViewMode;
  /** The current entry's pictures for `view: pictures`; null = the site's images. */
  show(): ProgramItem[] | null;
  /** Top frame only. */
  blackout(): Blackout | null;
  /** Top frame only: a page shown as a page, once it's loaded. */
  page(): PageShow | null;
  /** Top frame only: the post's embedded player is lifted (over its card, or filling the tab). */
  embedding(): boolean;
  pageEvent(e: PageEvent): void;
  onChange(cb: () => void): () => void;
  /** "Start" on the blackout (inside a user gesture). */
  start(): void;
  next(): void;
  /** The pointer moved over our overlay (the page doesn't see it): wake the arrows. */
  pointerMoved(): void;
  /** Hide the arrows (the selector picker is running). */
  suspendNav(on: boolean): void;
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
  /** The entry's info went to the runner (it really played, or the fallback fired). */
  let infoSent = false;
  let infoTimer: ReturnType<typeof setTimeout> | undefined;
  let gonePoll: ReturnType<typeof setInterval> | undefined;
  const sent = new Set<MediaEvent>();
  /** This page is shown as a page (no media to wait for); null: the usual. */
  let pageView: HashView | null = null;
  let page: PageShow | null = null;
  /** Bumped per page show, so late steps of an earlier one stop. */
  let pageRun = 0;
  let scroller: Scroller | null = null;
  /** The post's embedded player, lifted (with the card over its page, or filling the tab). */
  let embed: EmbedShow | null = null;
  /** `view=video` played as an embed: when it's over (nothing else will say). */
  let embedEnd: ReturnType<typeof setTimeout> | undefined;
  let embedWait: ReturnType<typeof setTimeout> | undefined;
  const adActive = () => ads.status()?.active ?? false;
  const listeners = new Set<() => void>();
  /** Top frame: previous / next over the entry, while the playlist runs here. */
  let nav: NavArrows | null = null;
  let navSuspended = false;

  function syncNav(on: boolean): void {
    if (!on || !isTop || !entry) {
      nav?.remove();
      nav = null;
      return;
    }
    nav ??= createNavArrows((step) => {
      browser.runtime.sendMessage({ type: PL_COMMAND, op: step }).catch(() => undefined);
    });
    nav.update(entry.index > 0);
    nav.suspend(navSuspended);
  }

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
  function showBlackout(title: string | null, forEntry: boolean, notice = false): void {
    if (!isTop) return;
    clearTimers();
    attempting = false;
    awaitingStart = forEntry;
    blackout = { title, notice, prompt: false, attempt: 0, status: null, canNext: entry !== null };
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
    if (!blackout || !awaitingStart || pageView) return;
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
    // The site starts its videos itself: Start / Next, but no tries of our own.
    if (attempting || agent.profile().site?.config.quirks?.startsItself) return;
    attempting = true;
    attempt(0);
  }

  /**
   * The primary has data but isn't playing: start the grace period before we start it.
   * Not on a site marked as starting its videos itself (`quirks.startsItself`): pressing
   * play there can fight the site's own start. The fallback Start / Next still shows.
   */
  function considerStarting(): void {
    if (!isTop || !blackout || !awaitingStart || attempting || graceTimer !== undefined || pageView) return;
    if (agent.profile().site?.config.quirks?.startsItself) return;
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
    const ad = adActive();
    if (ad || el.paused) cleanSince = null;
    else cleanSince ??= Date.now();
    if (seekDone || startS === null) return;
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

  /** The page's metadata, for the top frame's report. */
  function pageInfo(): MediaInfo {
    const info: MediaInfo = {};
    try {
      const m = pageMetadata(agent.profile().site);
      if (m.title) info.title = m.title;
      if (m.creator) info.creator = m.creator;
      if (m.thumbnail) info.thumbnailUrl = m.thumbnail;
      if (m.duration) info.durationS = m.duration;
    } catch (err) {
      console.warn('[wtv] reading the page metadata failed:', err);
    }
    return info;
  }

  function sendInfo(info: MediaInfo): void {
    if (!entry) return;
    infoSent = true;
    stopWatching();
    browser.runtime.sendMessage({ type: PL_INFO, gen: entry.gen, info }).catch(() => undefined);
  }

  /** Played long enough, ad-free: report the entry for the media library. */
  function maybeSendInfo(el: HTMLMediaElement): void {
    if (!entry || infoSent || cleanSince === null || Date.now() - cleanSince < INFO_AFTER_MS) return;
    const info = isTop ? pageInfo() : {};
    // The media's own duration beats what the page says.
    if (el.duration === Infinity) {
      info.live = true;
      delete info.durationS;
    } else if (Number.isFinite(el.duration) && el.duration >= 1) {
      info.durationS = el.duration;
    }
    sendInfo(info);
  }

  function stopWatching(): void {
    if (infoTimer !== undefined) clearTimeout(infoTimer);
    if (gonePoll !== undefined) clearInterval(gonePoll);
    infoTimer = gonePoll = undefined;
  }

  /** Until the entry plays: watch for the site's "unavailable" message; top frame: the info fallback. */
  function watchEntry(): void {
    stopWatching();
    if (!entry) return;
    if (isTop) {
      infoTimer = setTimeout(() => {
        infoTimer = undefined;
        if (!infoSent && !agent.primary()) sendInfo(pageInfo());
      }, INFO_FALLBACK_MS);
    }
    const until = Date.now() + GONE_WATCH_MS;
    gonePoll = setInterval(() => {
      if (infoSent || sent.has('gone') || Date.now() > until) {
        if (gonePoll !== undefined) clearInterval(gonePoll);
        gonePoll = undefined;
        return;
      }
      const matchers = unavailableMatchers(location.hostname, agent.profile().site?.config.roles.unavailable);
      if (!matchers.length) return;
      const found = matchRole('unavailable', matchers).match?.element;
      if (found && isElementVisible(found)) {
        console.info('[wtv] the site says this entry is unavailable');
        report('gone');
      }
    }, GONE_POLL_MS);
  }

  function onMediaEvent(el: HTMLMediaElement, type: string): void {
    if (!active() || pageView) return;
    trySeek(el);
    maybeSendInfo(el);
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

  // --- pages as shows ------------------------------------------------------------------

  function whenLoaded(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => setTimeout(resolve, PAGE_SETTLE_MS);
      if (document.readyState === 'complete') return done();
      const timer = setTimeout(done, PAGE_LOAD_MAX_MS);
      window.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true, signal },
      );
    });
  }

  /** Nothing on the page plays over the show (in this frame; embedded players are left alone). */
  function pausePageMedia(): void {
    for (const m of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
      if (!m.paused) m.pause();
    }
  }

  function stopPageShow(): void {
    pageRun++;
    scroller?.stop();
    scroller = null;
    page = null;
    stopEmbed();
  }

  function stopEmbed(): void {
    clearTimeout(embedEnd);
    clearTimeout(embedWait);
    embedEnd = embedWait = undefined;
    if (!embed) return;
    embed.stop();
    embed = null;
    notify();
  }

  /**
   * `view=video` and nothing has played: if the post has an embedded player, lift it to
   * fill the tab and play for `dur=` (or a minute).
   */
  function watchForEmbed(run: number): void {
    const site = agent.profile().site;
    if (!isTop || !entry || !site?.config.roles.postEmbed?.length) return;
    void whenLoaded().then(() => {
      if (run !== pageRun || signal.aborted) return;
      embedWait = setTimeout(() => {
        embedWait = undefined;
        if (run !== pageRun || !entry || !blackout || !awaitingStart || agent.primary()) return;
        if (!findPostEmbed(site)) return;
        console.info('[wtv] no player of its own here; showing the post’s embedded player');
        embed = showEmbed(() => findPostEmbed(site), { kind: 'full' });
        lift();
        notify();
        report('playing');
        const durS = endS !== null ? Math.max(1, endS - (startS ?? 0)) : EMBED_DEFAULT_S;
        sendInfo({ ...pageInfo(), durationS: durS });
        embedEnd = setTimeout(() => {
          embedEnd = undefined;
          if (run === pageRun) report('ended');
        }, durS * 1000);
      }, EMBED_WAIT_MS);
    });
  }

  async function runPageShow(view: HashView, speed: number | null, durS: number | null): Promise<void> {
    const run = ++pageRun;
    await whenLoaded();
    if (run !== pageRun || signal.aborted) return;
    pausePageMedia();
    if (view === 'card') {
      void readPost(run);
      return;
    }
    if (view === 'read') {
      const html = document.documentElement.outerHTML.slice(0, MAX_READ_HTML);
      page = { kind: 'read', id: run, url: location.href, html, wpm: speed ?? DEFAULT_WPM, durS };
      lift(); // Notifies: the overlay takes it from here.
      return;
    }
    startScroll(run, speed ?? DEFAULT_SCROLL_PX_S, durS);
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** `v=card`: read the post with the site's post selectors, and hand it to the runner. */
  async function readPost(run: number): Promise<void> {
    const site = agent.profile().site;
    const unavailable = unavailableMatchers(location.hostname, site?.config.roles.unavailable);
    const saysGone = () => unavailable.length > 0 && matchRole('unavailable', unavailable).match !== null;
    const until = performance.now() + POST_WAIT_MS;
    let result: PostResult;
    for (;;) {
      if (run !== pageRun || signal.aborted) return;
      // Apps start their videos late; nothing should play behind the blackout.
      pausePageMedia();
      if (saysGone()) {
        result = { ok: false, gone: true, error: `${site?.config.name ?? location.hostname} says this post isn’t available` };
        break;
      }
      if (!site || !hasPostSelectors(site.config.roles)) {
        result = { ok: false, gone: false, error: `No post selectors for ${location.hostname} (Fix selectors → Posts)` };
        break;
      }
      if (readPagePost(site).post) {
        await sleep(POST_SETTLE_MS);
        if (run !== pageRun || signal.aborted) return;
        // A removed post keeps its title; the banner saying so can come in after it.
        const post = saysGone() ? null : readPagePost(site).post;
        if (post) {
          result = { ok: true, post };
          break;
        }
      }
      if (performance.now() >= until) {
        result = { ok: false, gone: false, error: `Couldn’t find the post on this page with ${site.config.name}’s post selectors` };
        break;
      }
      await sleep(POST_POLL_MS);
    }
    console.info('[wtv] post read from the page:', result.ok ? result.post.title ?? result.post.text.slice(0, 60) : result.error);
    if (entry) {
      // An embedded player can't leave its page: the card comes here instead.
      const inPage = result.ok && site !== null && findPostEmbed(site) !== null;
      browser.runtime.sendMessage({ type: PL_PAGE_POST, gen: entry.gen, result, inPage }).catch(() => undefined);
      if (inPage && site) {
        console.info('[wtv] the post has an embedded player; showing its card on this page');
        embed = showEmbed(() => findPostEmbed(site), { kind: 'card', frame: cardFrame(`gen=${entry.gen}&embed=1`) });
        notify();
      }
      return;
    }
    // A stand-alone #wtv:v=card link: nothing to hand it to; back to the page.
    lift();
  }

  function startScroll(run: number, pxPerS: number, durS: number | null): void {
    page = { kind: 'scroll', id: run };
    lift();
    notify();
    scroller = startScroller({ pxPerS, durS, onDone: () => finishPage(run) });
    report('playing');
    if (entry) sendInfo({ ...pageInfo(), durationS: scrollDurationS(scroller.remainingPx(), pxPerS, durS) });
  }

  function finishPage(run: number): void {
    if (run !== pageRun) return;
    console.info('[wtv] page show finished');
    scroller = null;
    if (entry) {
      report('ended');
      return;
    }
    // A stand-alone #wtv:v= link: back to the page.
    page = null;
    notify();
  }

  const onMessage = (raw: unknown) => {
    const msg = parsePlaylistApply(raw);
    if (!msg || !isTop) return undefined;
    if (msg.op === 'lift') {
      lift();
      // A frame's own player started (Wtv runs in the embed after all): it reports its end.
      if (embedEnd !== undefined && !pageView) {
        clearTimeout(embedEnd);
        embedEnd = undefined;
      }
    } else if (msg.op === 'release') {
      lift();
      stopEmbed();
      syncNav(false);
    } else if (msg.op === 'blocked') trigger('blocked-in-frame');
    else if (msg.op === 'blackout') showBlackout(msg.title, false, msg.notice);
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
    syncNav(false);
    offPrimary();
    primaryCleanup?.();
    clearTimers();
    stopWatching();
    stopPageShow();
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
    syncNav(false);
    fromHash = hash !== null;
    endS = hash?.end ?? null;
    startS = hash?.t ?? (endS !== null ? 0 : null);
    endDone = false;
    seekDone = false;
    cleanSince = null;
    infoSent = false;
    stopWatching();
    sent.clear();
    stopPageShow();
    pageView = hash?.view ?? null;
    if (hash) {
      // A page show has nothing to start: no Start prompt, no autoplay attempts.
      showBlackout(hash.title ?? location.hostname, !pageView);
      watchPrimary();
    }
    browser.runtime
      .sendMessage({ type: PL_HELLO })
      .then((raw: unknown) => {
        entry = parseEntryInfo(raw);
        syncNav(true);
        if (!entry) {
          if (pageView && isTop) void runPageShow(pageView, null, hash?.end ?? null);
          return;
        }
        if (isPageView(entry.view) || entry.view === 'card') {
          pageView = entry.view;
          if (!isTop) return;
          if (hash && blackout) update({ canNext: true, title: entry.title ?? blackout.title });
          else showBlackout(entry.title ?? (document.title || location.hostname), false);
          void runPageShow(entry.view, entry.speed, entry.endS);
          return;
        }
        pageView = null;
        endS = entry.endS;
        startS = entry.startS ?? (endS !== null ? 0 : null);
        watchEntry();
        if (hash && blackout) update({ canNext: true, title: entry.title ?? blackout.title });
        else showBlackout(entry.title ?? (document.title || location.hostname), true);
        watchPrimary();
        watchForEmbed(pageRun);
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
    page: () => page,
    embedding: () => embed !== null,
    pageEvent(e) {
      if (!page || page.id !== e.id || e.id !== pageRun) return;
      if (e.type === 'started') {
        report('playing');
        if (entry) sendInfo({ ...pageInfo(), durationS: e.durationS });
      } else if (e.type === 'failed') {
        console.info('[wtv] no article found on this page; scrolling it instead');
        startScroll(e.id, DEFAULT_SCROLL_PX_S, page.kind === 'read' ? page.durS : null);
      } else {
        finishPage(e.id);
      }
    },
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
    pointerMoved() {
      nav?.poke();
    },
    suspendNav(on) {
      navSuspended = on;
      nav?.suspend(on);
    },
  };
}
