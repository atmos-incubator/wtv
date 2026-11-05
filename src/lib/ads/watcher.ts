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
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isElementVisible, matchRole } from '../dom/query';
import type { MediaAgent } from '../media/agent';
import type { AdStatus } from '../messages';
import { scheduler } from '../schedule';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../settings';
import type { SiteProfile } from '../sites/registry';
import { KEYS } from '../storage';
import { createAdReporter } from './reporter';

export const AD_END_GRACE_MS = 1500;
const EVALUATE_DELAY_MS = 150;
const SKIP_RETRY_MS = 1000;
const SKIP_MAX_ATTEMPTS = 3;
const PRIMARY_EVENTS = ['timeupdate', 'playing', 'loadedmetadata', 'durationchange', 'emptied'] as const;

export interface AdWatcher {
  status(): AdStatus | null;
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
  let skipTarget: WeakRef<Element> | null = null;
  let skipAttempts = 0;
  let lastSkipAt = 0;
  let observing = false;
  let primaryCleanup: (() => void) | null = null;

  const evaluateSoon = scheduler(evaluate, EVALUATE_DELAY_MS, signal);
  const mutations = new MutationObserver(evaluateSoon);

  const roles = () => agent.profile().site?.config.roles;

  function log(...args: unknown[]): void {
    if (options.debug) console.debug('[wtv] ads:', ...args);
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
        log('ad started');
        report();
      }
    } else if (reported && endTimer === undefined) {
      endTimer = setTimeout(() => {
        endTimer = undefined;
        if (signal.aborted || rawActive) return;
        reported = false;
        skipTarget = null;
        skipAttempts = 0;
        log('ad ended');
        report();
      }, AD_END_GRACE_MS);
    }
  }

  function trySkip(): void {
    const matchers = roles()?.skip;
    if (!rawActive || !settings.autoSkip || !matchers) return;
    const { match, errors } = matchRole('skip', matchers);
    selectorErrors.push(...errors);
    const el = match?.element;
    if (!el || !isClickable(el)) return;

    const now = Date.now();
    if (skipTarget?.deref() === el) {
      if (skipAttempts >= SKIP_MAX_ATTEMPTS || now - lastSkipAt < SKIP_RETRY_MS) return;
    } else {
      skipTarget = new WeakRef(el);
      skipAttempts = 0;
    }
    skipAttempts++;
    lastSkipAt = now;
    skipClicks++;
    log(`clicking skip (attempt ${skipAttempts})`, el);
    (el as HTMLElement).click();
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
    browser.storage.onChanged.removeListener(onStorageChanged);
    reporter.close();
  });

  // Tell the background the ad is over if the page goes away mid-ad (bfcache, etc.).
  // The port closing on unload covers this too; this just makes it immediate.
  window.addEventListener(
    'pagehide',
    () => {
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
        selectorErrors: [...new Set(selectorErrors)],
      };
    },
  };
}
