/**
 * Shows the overlay over the primary video while an ad plays.
 *
 * The program is the default `[img]` slideshow for now; step 7 (playlists) passes the
 * entry's `[ads]` block instead. The ✕ on the overlay hides it for the rest of the
 * current ad only.
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import type { MediaAgent } from '../media/agent';
import { createOverlayHost, type OverlayTarget } from './host';
import { DEFAULT_AD_ITEMS } from './program';

export interface AdOverlay {
  /** Dev aid: show the ad overlay for `ms` without an ad. Returns false with nothing to cover. */
  preview(ms: number): boolean;
  /** Get out of the way (e.g. while the selector picker runs), then come back. */
  suspend(on: boolean): void;
}

export function startAdOverlay(ctx: ContentScriptContext, agent: MediaAgent, ads: AdWatcher): AdOverlay {
  const overlay = createOverlayHost(ctx.signal);
  let dismissed = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;

  // Only cover something that's on screen. Audio-only ads just get muted.
  const target: OverlayTarget = () => agent.primary()?.rect() ?? null;
  const siteHasAds = () => Boolean(agent.profile().site?.config.roles.adIndicator?.length);

  function sync(): void {
    const active = ads.status()?.active ?? false;
    const settings = ads.settings();
    if (!active) dismissed = false;
    if (active && settings.adOverlay && !dismissed && !suspended) {
      overlay.show(
        { type: 'ad', host: location.hostname, items: [...DEFAULT_AD_ITEMS], muted: settings.muteAds },
        target,
      );
    } else {
      overlay.hide();
    }
  }

  overlay.onEvent((event) => {
    if (event.type === 'dismiss') {
      dismissed = true;
      overlay.hide();
    }
  });

  const offAd = ads.onAdChange(sync);
  const offSettings = ads.onSettingsChange((settings) => {
    // Preload where ads are expected so the first one covers instantly.
    if (settings.adOverlay && siteHasAds()) overlay.preload();
    sync();
  });
  const offProfile = agent.onProfileChange(() => {
    if (ads.settings().adOverlay && siteHasAds()) overlay.preload();
  });

  ctx.onInvalidated(() => {
    offAd();
    offSettings();
    offProfile();
    if (previewTimer !== undefined) clearTimeout(previewTimer);
  });

  return {
    preview(ms) {
      if (!target()) return false;
      overlay.show({ type: 'ad', host: location.hostname, items: [...DEFAULT_AD_ITEMS], muted: false }, target);
      if (previewTimer !== undefined) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        sync();
      }, ms);
      return true;
    },
    suspend(on) {
      suspended = on;
      if (on && previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      sync();
    },
  };
}
