/**
 * Content-script ad watcher. Runs only where the site config has an `adIndicator` role.
 *
 * Re-evaluates (at most every 150 ms) on:
 *   - DOM mutations: child lists, and `class` / `hidden` attributes (sites toggle ad
 *     state with classes, e.g. YouTube's `#movie_player.ad-showing`).
 *   - Primary media events, including `timeupdate` as a heartbeat while something
 *     plays. That catches visibility changes made through inline styles, which aren't
 *     observed because players animate styles constantly.
 *   - Profile or settings changes.
 *
 * Ad start is reported immediately. Ad end waits out a grace period, so back-to-back
 * ads don't flash the sound on between them.
 *
 * Skip: the `skip` role first. Failing that, a visible button inside the site's `player`
 * role that looks like a Skip button (see findUnlistedSkip), then anything saying "skip"
 * where the show is or was (the ad probe, probe.ts). Unlisted buttons are logged so they
 * can be added to the role: sites add ad formats with their own Skip buttons faster than
 * configs can follow.
 *
 * While an ad shows, the probe runs every PROBE_EVERY_MS. Its latest result is in
 * status().probe, and dev builds log it to the console whenever it changes.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { CLICK_STRATEGIES, activate, type ClickStrategy } from '../dom/click';
import { isElementVisible, matchRole } from '../dom/query';
import type { MediaAgent } from '../media/agent';
import type { AdStatus } from '../messages';
import { scheduler } from '../schedule';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../settings';
import type { SiteProfile } from '../sites/registry';
import { KEYS } from '../storage';
import type { Box } from '../overlay/shield';
import { WTV_UI_ATTR, probeAds, probeSignature, type AdProbe, type ProbeArea } from './probe';
import { createAdReporter } from './reporter';
import { SKIP_CANDIDATES, describeElement, looksLikeSkip } from './skip';

export const AD_END_GRACE_MS = 1500;
const EVALUATE_DELAY_MS = 150;
const SKIP_RETRY_MS = 1000;
/** How soon after a click the button must be gone (or the ad over) to credit that click. */
const SKIP_CREDIT_MS = 1500;
const PROBE_EVERY_MS = 500;
const PRIMARY_EVENTS = ['timeupdate', 'playing', 'loadedmetadata', 'durationchange', 'emptied'] as const;

export interface AdWatcher {
  status(): AdStatus | null;
  settings(): Settings;
  /** Fires when the reported ad state flips (start immediately, end after the grace). */
  onAdChange(cb: (active: boolean) => void): () => void;
  /** Fires after settings load or change. */
  onSettingsChange(cb: (settings: Settings) => void): () => void;
  /** Run the ad probe now, ad or not (dev snapshot). Null with nowhere to look. */
  probeNow(): { probe: AdProbe; areas: ProbeArea[] } | null;
}

function isClickable(el: Element): boolean {
  if (!isElementVisible(el)) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return getComputedStyle(el).pointerEvents !== 'none';
}

export function startAdWatcher(
  ctx: ContentScriptContext,
  agent: MediaAgent,
  options: { debug: boolean },
): AdWatcher {
  const { signal } = ctx;
  const reporter = createAdReporter(signal);

  let settings: Settings = { ...DEFAULT_SETTINGS };
  /** What the DOM says right now. */
  let rawActive = false;
  /** What we've reported (stays true through the grace period). */
  let reported = false;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let selectorErrors: string[] = [];
  let skipClicks = 0;
  let skipSeeks = 0;
  /** This ad was already seeked to its end (once per Skip button). */
  let seekedPast = false;
  let skipTarget: WeakRef<Element> | null = null;
  let skipAttempts = 0;
  let lastSkipAt = 0;
  /** The strategy of the last click on skipTarget, until it's credited or given up on. */
  let pendingStrategy: ClickStrategy | null = null;
  /** The last strategy that made a Skip button go away, and every attempt this page. */
  let skipWorked: ClickStrategy | null = null;
  const skipLog: string[] = [];
  /** Unlisted Skip buttons already reported to the console. */
  const reportedUnlisted = new WeakSet<Element>();
  /** Where the primary video was (page coordinates) the last time no ad showed. */
  let homeRect: Box | null = null;
  let adStartedAt = 0;
  let lastProbeAt = 0;
  let lastProbeSig = '';
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastProbe: AdProbe | null = null;
  let probeCandidates: Element[] = [];
  let observing = false;
  let primaryCleanup: (() => void) | null = null;
  const adListeners = new Set<(active: boolean) => void>();
  const settingsListeners = new Set<(settings: Settings) => void>();

  function notify<T>(set: Set<(v: T) => void>, value: T): void {
    for (const cb of set) {
      try {
        cb(value);
      } catch (err) {
        console.error('[wtv] ads listener failed:', err);
      }
    }
  }

  const evaluateSoon = scheduler(evaluate, EVALUATE_DELAY_MS, signal);
  const mutations = new MutationObserver(evaluateSoon);

  const roles = () => agent.profile().site?.config.roles;

  function log(...args: unknown[]): void {
    if (options.debug) console.debug(`[wtv] ads +${Math.round(performance.now())}ms:`, ...args);
  }

  function report(): void {
    reporter.set(reported, settings.muteAds);
  }

  function setRaw(active: boolean): void {
    rawActive = active;
    if (active) {
      if (endTimer !== undefined) {
        clearTimeout(endTimer);
        endTimer = undefined;
      }
      if (!reported) {
        reported = true;
        adStartedAt = performance.now();
        lastProbeAt = 0;
        lastProbeSig = '';
        lastProbe = null;
        log('ad started');
        report();
        notify(adListeners, true);
      }
    } else if (reported && endTimer === undefined) {
      endTimer = setTimeout(() => {
        endTimer = undefined;
        if (signal.aborted || rawActive) return;
        reported = false;
        skipTarget = null;
        skipAttempts = 0;
        seekedPast = false;
        probeCandidates = [];
        log('ad ended');
        report();
        notify(adListeners, false);
      }, AD_END_GRACE_MS);
    }
  }

  /** A clickable Skip-looking button inside the player box, when no skip selector matched. */
  function findUnlistedSkip(): Element | null {
    const matchers = roles()?.player;
    const player = matchers ? matchRole('player', matchers).match?.element : null;
    if (!player) return null;
    for (const el of player.querySelectorAll(SKIP_CANDIDATES)) {
      if (looksLikeSkip(el) && isClickable(el)) return el;
    }
    return null;
  }

  function noteSkip(entry: string): void {
    skipLog.push(`+${Math.round(performance.now() - adStartedAt)}ms ${entry}`);
    if (skipLog.length > 20) skipLog.shift();
    log(entry);
  }

  /** The last click's button went away, or the ad ended, soon after: that click worked. */
  function creditSkip(): void {
    if (!pendingStrategy) return;
    const target = skipTarget?.deref();
    const gone = !rawActive || !target?.isConnected || !isClickable(target);
    if (!gone) return;
    if (Date.now() - lastSkipAt <= SKIP_CREDIT_MS) {
      skipWorked = pendingStrategy;
      noteSkip(`skip worked: ${pendingStrategy}`);
      console.info(`[wtv] ads: the Skip button responded to the "${pendingStrategy}" click strategy.`);
    }
    pendingStrategy = null;
  }

  function trySkip(): void {
    creditSkip();
    const matchers = roles()?.skip;
    if (!rawActive || !settings.autoSkip) return;
    let el: Element | null = null;
    if (matchers) {
      const { match, errors } = matchRole('skip', matchers);
      selectorErrors.push(...errors);
      if (match && isClickable(match.element)) el = match.element;
    }
    const matchedSkip = el;
    el ??= findUnlistedSkip() ?? probeCandidates.find((c) => c.isConnected && isClickable(c)) ?? null;
    if (el && el !== matchedSkip && !reportedUnlisted.has(el)) {
      reportedUnlisted.add(el);
      console.info(
        `[wtv] ads: clicking a Skip button that isn't in this site's skip role: ${describeElement(el)}. ` +
          'Add a selector for it (Fix selectors… → Skip button) so it stays found.',
        el,
      );
    }
    if (!el) return;

    const now = Date.now();
    if (skipTarget?.deref() === el) {
      if (now - lastSkipAt < SKIP_RETRY_MS) return;
      // We clicked and the button is still here: the site ignores synthetic clicks
      // (YouTube checks isTrusted). Where ads play in the main video, a skippable ad can
      // be skipped by seeking it to its end instead.
      if (!seekedPast && agent.profile().site?.config.quirks?.adsInMainVideo && seekPastAd()) {
        // If the button goes now, the seek did it, not the click.
        pendingStrategy = null;
        noteSkip('click ignored; seeked the ad to its end');
        lastSkipAt = now;
        return;
      }
      if (skipAttempts >= CLICK_STRATEGIES.length) {
        if (pendingStrategy) noteSkip(`skip ignored every click strategy: ${describeElement(el)}`);
        pendingStrategy = null;
        return;
      }
    } else {
      skipTarget = new WeakRef(el);
      skipAttempts = 0;
      seekedPast = false;
    }
    // What worked last time first, then the rest in order.
    const order = skipWorked ? [skipWorked, ...CLICK_STRATEGIES.filter((s) => s !== skipWorked)] : CLICK_STRATEGIES;
    const strategy = order[skipAttempts]!;
    skipAttempts++;
    lastSkipAt = now;
    skipClicks++;
    pendingStrategy = strategy;
    noteSkip(`clicking skip (${strategy}): ${describeElement(el)}`);
    if (el instanceof HTMLElement) activate(el, strategy, (e) => e.hasAttribute(WTV_UI_ATTR));
  }

  /**
   * Seek the ad playing in the primary video to its end. Returns true if it did.
   * Only while the primary is playing: with ads in the main video that's the ad. A
   * paused primary under an ad is the show itself, held while the site draws a static
   * (image) ad, and seeking that would jump to the end of the show.
   */
  function seekPastAd(): boolean {
    const primary = agent.primary();
    const f = primary?.features(null);
    const duration = f?.duration ?? NaN;
    if (!primary || !f?.playing || !Number.isFinite(duration) || duration <= 0) return false;
    seekedPast = true;
    skipSeeks++;
    log(`skip button ignored our click; seeking the ad to its end (${Math.round(duration)}s)`);
    primary.seek(duration);
    return true;
  }

  /** Remember where the show is, so the probe can look there once an ad moves it. */
  function trackHome(): void {
    const r = agent.primary()?.rect();
    if (!r || r.width <= 0 || r.height <= 0) return;
    homeRect = { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height };
  }

  function probeAreas(): ProbeArea[] {
    const areas: ProbeArea[] = [];
    const playerMatchers = roles()?.player;
    const player = playerMatchers ? matchRole('player', playerMatchers).match?.element : null;
    const pr = player?.getBoundingClientRect();
    if (pr && pr.width > 0 && pr.height > 0) areas.push({ name: 'player', rect: pr });
    const vr = agent.primary()?.rect();
    if (vr && vr.width > 0 && vr.height > 0) areas.push({ name: 'video', rect: vr });
    if (homeRect) {
      areas.push({
        name: 'video-before-ad',
        rect: { ...homeRect, left: homeRect.left - window.scrollX, top: homeRect.top - window.scrollY },
      });
    }
    return areas;
  }

  function runProbe(): void {
    const now = performance.now();
    if (now - lastProbeAt < PROBE_EVERY_MS) return;
    lastProbeAt = now;
    // Static ads can sit with nothing playing and nothing mutating: keep looking.
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeTimer = undefined;
      if (rawActive) evaluateSoon();
    }, PROBE_EVERY_MS);

    const areas = probeAreas();
    if (areas.length === 0) return;
    const { probe, candidates } = probeAds(areas, adStartedAt);
    lastProbe = probe;
    probeCandidates = candidates;
    const sig = probeSignature(probe);
    if (sig === lastProbeSig || !options.debug) return;
    lastProbeSig = sig;
    logProbe(probe, candidates);
  }

  function logProbe(probe: AdProbe, candidates: Element[]): void {
    const visibleHits = probe.skip.filter((s) => s.visible && s.areas.length > 0).length;
    console.groupCollapsed(
      `[wtv] ads probe +${probe.at}ms: ${visibleHits} visible "skip" in the show area, ` +
        `${probe.skip.length} on the page, ${probe.frames.length} iframe(s)`,
    );
    console.log('areas', probe.areas);
    console.log('top-most element per sample point', probe.under);
    console.log('element stack at each centre (top first)', probe.stack);
    if (probe.skip.length > 0) {
      console.table(probe.skip.map(({ html: _html, areas, ...rest }) => ({ ...rest, areas: areas.join(', ') })));
      for (const s of probe.skip) console.log(`${s.target} html:`, s.html);
    }
    if (probe.frames.length > 0) console.table(probe.frames);
    if (candidates.length > 0) console.log('click candidates (live elements)', candidates);
    console.groupEnd();
  }

  function evaluate(): void {
    const matchers = roles()?.adIndicator;
    if (!matchers) {
      setRaw(false);
      return;
    }
    const { match, errors } = matchRole('adIndicator', matchers);
    selectorErrors = errors;
    setRaw(match !== null);
    if (rawActive) runProbe();
    else trackHome();
    trySkip();
  }

  /** Start / stop DOM observation depending on whether this site has ad selectors. */
  function syncObservation(profile: SiteProfile): void {
    const wanted = Boolean(profile.site?.config.roles.adIndicator?.length);
    if (wanted && !observing) {
      mutations.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'hidden'],
      });
      observing = true;
    } else if (!wanted && observing) {
      mutations.disconnect();
      observing = false;
    }
    evaluateSoon();
  }

  function watchPrimary(): void {
    primaryCleanup?.();
    primaryCleanup = null;
    const el = agent.primary()?.element;
    if (!el) return;
    const controller = new AbortController();
    const opts = { passive: true, signal: AbortSignal.any([signal, controller.signal]) };
    for (const type of PRIMARY_EVENTS) el.addEventListener(type, evaluateSoon, opts);
    primaryCleanup = () => controller.abort();
  }

  async function loadSettings(): Promise<void> {
    try {
      const raw = await browser.storage.local.get(KEYS.settings);
      settings = parseSettings(raw[KEYS.settings]);
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
    report();
    notify(settingsListeners, settings);
    evaluateSoon();
  }

  const onStorageChanged = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && KEYS.settings in changes) void loadSettings();
  };
  browser.storage.onChanged.addListener(onStorageChanged);

  const offProfile = agent.onProfileChange(syncObservation);
  const offPrimary = agent.onPrimaryChange(watchPrimary);

  ctx.onInvalidated(() => {
    mutations.disconnect();
    offProfile();
    offPrimary();
    primaryCleanup?.();
    if (endTimer !== undefined) clearTimeout(endTimer);
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    browser.storage.onChanged.removeListener(onStorageChanged);
    reporter.close();
  });

  // Tell the background the ad is over if the page goes away mid-ad (bfcache, etc.).
  // The port closing on unload covers this too; this just makes it immediate.
  window.addEventListener(
    'pagehide',
    () => {
      if (reported) notify(adListeners, false);
      reported = false;
      reporter.close();
    },
    { signal },
  );

  void loadSettings();
  syncObservation(agent.profile());
  watchPrimary();

  return {
    status() {
      if (!roles()?.adIndicator) return null;
      return {
        active: reported,
        muteAds: settings.muteAds,
        autoSkip: settings.autoSkip,
        skipClicks,
        skipSeeks,
        skipWorked,
        skipLog: [...skipLog],
        probe: lastProbe,
        selectorErrors: [...new Set(selectorErrors)],
      };
    },
    settings: () => settings,
    onAdChange(cb) {
      adListeners.add(cb);
      return () => adListeners.delete(cb);
    },
    onSettingsChange(cb) {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },
    probeNow() {
      const areas = probeAreas();
      if (areas.length === 0) return null;
      return { probe: probeAds(areas, rawActive ? adStartedAt : performance.now()).probe, areas };
    },
  };
}
