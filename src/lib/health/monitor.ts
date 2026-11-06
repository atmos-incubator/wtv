/**
 * Content script: check the site's player roles once per page, after the primary video
 * has played CHECK_AFTER_MS with no ad showing, and report to the background (which
 * keeps the streaks and shows the badge). See health.ts for what's judged and why.
 *
 * "Matched" here means a selector finds an element at all: controls fade out while a
 * video plays, so a role's `visible` condition would fail on a healthy page. The video
 * role passes when its selectors picked the playing primary.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import { deepQueryAll } from '../dom/query';
import type { MediaAgent } from '../media/agent';
import type { CandidateFeatures } from '../media/score';
import { HEALTH_REPORT, PLAYER_ROLES, type HealthReport } from './health';

const CHECK_AFTER_MS = 10_000;
/** Same bar as the click shield's "is this a show": not a preview or a GIF-style loop. */
const MIN_SHOW_S = 30;

function looksLikeTheShow(f: CandidateFeatures): boolean {
  if (!f.isVideo || !f.hasSource || f.loop || f.visibleArea <= 0) return false;
  if (!(f.duration === Infinity || f.duration >= MIN_SHOW_S)) return false;
  // A broken video role means configMatch is false, so also accept an audible video.
  return f.configMatch || f.audible;
}

export function startHealthMonitor(ctx: ContentScriptContext, agent: MediaAgent, ads: AdWatcher): void {
  const { signal } = ctx;
  /** Page (URL without hash) being timed, and the one last checked. SPAs change URL in place. */
  let timingKey = '';
  let checkedKey = '';
  let playedMs = 0;
  let lastTick: number | null = null;
  let cleanup: (() => void) | null = null;

  const pageKey = () => location.href.split('#')[0] ?? location.href;

  function check(): void {
    const site = agent.profile().site;
    const f = agent.primaryFeatures();
    if (!site || !f || !looksLikeTheShow(f)) return;
    const results: HealthReport['results'] = {};
    for (const role of PLAYER_ROLES) {
      const matchers = site.config.roles[role];
      if (!matchers?.length) continue;
      results[role] =
        role === 'video' ? f.configMatch : matchers.some((m) => deepQueryAll(m.selector).elements.length > 0);
    }
    if (Object.keys(results).length === 0) return;
    const report: HealthReport = { type: HEALTH_REPORT, siteId: site.config.id, results };
    browser.runtime.sendMessage(report).catch(() => undefined);
  }

  function onTick(el: HTMLMediaElement): void {
    const key = pageKey();
    if (key === checkedKey) return;
    if (key !== timingKey) {
      timingKey = key;
      playedMs = 0;
      lastTick = null;
    }
    const now = performance.now();
    const counting = !el.paused && !(ads.status()?.active ?? false);
    // timeupdate fires ~4×/s; cap each step so a long gap (tab in background) can't count.
    if (counting && lastTick !== null) playedMs += Math.min(now - lastTick, 1000);
    lastTick = counting ? now : null;
    if (playedMs < CHECK_AFTER_MS) return;
    checkedKey = key;
    check();
  }

  const offPrimary = agent.onPrimaryChange(() => {
    cleanup?.();
    cleanup = null;
    const el = agent.primary()?.element;
    if (!el) return;
    const controller = new AbortController();
    el.addEventListener('timeupdate', () => onTick(el), {
      passive: true,
      signal: AbortSignal.any([signal, controller.signal]),
    });
    cleanup = () => controller.abort();
  });

  ctx.onInvalidated(() => {
    offPrimary();
    cleanup?.();
  });
}
