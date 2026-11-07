/**
 * "Video paused. Continue watching?" dialogs (YouTube's, or any site's via the
 * `continuePrompt` role): confirm them so a TV keeps playing.
 *
 * - Looked for only after the primary video pauses (the dialog pauses it), for
 *   WATCH_AFTER_PAUSE_MS, not watched all the time.
 * - Only when nobody is using the page: no trusted key press, click or wheel on it for
 *   IDLE_MS. Sites reuse the same dialog for confirmations people ask for (YouTube's
 *   "Delete playlist?"), and those always follow a click, so an idle page means it's the
 *   site asking whether anyone's there.
 * - The button gets the Skip button's click strategies, one per second. If it's still
 *   there after all of them, Wtv plays the video itself and hides the dialog.
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { WTV_UI_ATTR } from '../ads/probe';
import { describeElement } from '../ads/skip';
import { record } from '../dev/timeline';
import { CLICK_STRATEGIES, activate } from '../dom/click';
import { isElementVisible, matchRole } from '../dom/query';
import type { MediaAgent } from '../media/agent';

export const IDLE_MS = 60_000;
const WATCH_AFTER_PAUSE_MS = 15_000;
const POLL_MS = 500;
const ATTEMPT_EVERY_MS = 1000;
const USER_INPUT = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function startContinuePrompt(ctx: ContentScriptContext, agent: MediaAgent): void {
  const { signal } = ctx;
  let lastInputAt = performance.now();
  let watchUntil = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  let target: WeakRef<Element> | null = null;
  let attempts = 0;
  let lastAttemptAt = 0;
  let primaryCleanup: (() => void) | null = null;

  for (const type of USER_INPUT) {
    window.addEventListener(
      type,
      (e) => {
        if (e.isTrusted) lastInputAt = performance.now();
      },
      { capture: true, passive: true, signal },
    );
  }

  const matchers = () => agent.profile().site?.config.roles.continuePrompt;

  function stop(): void {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  }

  function check(): void {
    const now = performance.now();
    if (now > watchUntil) {
      stop();
      return;
    }
    const roles = matchers();
    const found = roles ? matchRole('continuePrompt', roles).match?.element : null;
    const button = found && isElementVisible(found) ? found : null;
    const previous = target?.deref();

    if (!button) {
      if (previous && attempts > 0) {
        const how = attempts <= CLICK_STRATEGIES.length ? CLICK_STRATEGIES[attempts - 1] : 'play + hide';
        console.info(`[wtv] continue prompt dismissed (${how}).`);
        record('prompts', `continue prompt gone after attempt ${attempts} (${how})`);
      }
      target = null;
      attempts = 0;
      return;
    }
    if (now - lastInputAt < IDLE_MS) return; // Someone's here: it's their dialog.
    if (previous !== button) {
      target = new WeakRef(button);
      attempts = 0;
      lastAttemptAt = 0;
      record('prompts', `continue prompt showing: ${describeElement(button)}`);
    }
    if (now - lastAttemptAt < ATTEMPT_EVERY_MS) return;
    lastAttemptAt = now;

    if (attempts < CLICK_STRATEGIES.length) {
      const strategy = CLICK_STRATEGIES[attempts]!;
      attempts++;
      record('prompts', `clicking continue (${strategy})`);
      if (button instanceof HTMLElement) activate(button, strategy, (e) => e.hasAttribute(WTV_UI_ATTR));
      return;
    }
    if (attempts === CLICK_STRATEGIES.length) {
      attempts++;
      console.info('[wtv] continue prompt ignored every click; playing the video and hiding the dialog.');
      record('prompts', 'continue prompt ignored clicks: play + hide');
      void agent.primary()?.play();
      const dialog = button.closest('dialog, [role="dialog"], [aria-modal="true"]');
      if (dialog instanceof HTMLElement) dialog.style.setProperty('display', 'none', 'important');
    }
  }

  function onPause(): void {
    if (!matchers()?.length) return;
    watchUntil = performance.now() + WATCH_AFTER_PAUSE_MS;
    if (poll === undefined) poll = setInterval(check, POLL_MS);
  }

  function watchPrimary(): void {
    primaryCleanup?.();
    primaryCleanup = null;
    const el = agent.primary()?.element;
    if (!el) return;
    const controller = new AbortController();
    el.addEventListener('pause', onPause, { passive: true, signal: AbortSignal.any([signal, controller.signal]) });
    primaryCleanup = () => controller.abort();
  }

  const offPrimary = agent.onPrimaryChange(watchPrimary);
  ctx.onInvalidated(() => {
    offPrimary();
    primaryCleanup?.();
    stop();
  });
  watchPrimary();
}
