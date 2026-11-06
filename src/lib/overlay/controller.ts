/**
 * Decides what the overlay iframe shows over the primary video. Highest priority first:
 *
 *   1. Selector picker running         → nothing (suspend)
 *   2. Playlist entry loading          → blackout with the title over the whole tab
 *                                        (top frame), then Start / Next if nothing plays
 *   3. Dev preview                     → ad slideshow
 *   4. Ad playing, pictures on         → ad slideshow (also the ad click shield)
 *   5. Click shield on, and the primary video is
 *        maximized                     → transparent shield over everything, idle cursor hides
 *        in an ad (pictures off)       → transparent shield over everything
 *        a show (isShow)               → transparent shield, site control bar left uncovered
 *   6. Otherwise                       → nothing
 *
 * The ✕ on the ad slideshow hides the overlay, shield included, for the rest of that ad.
 * The ad program is the playlist entry's `[ads]` block, or the default `[img]` slideshow.
 *
 * Shield events: click → play / pause, except in the strip just above the site's progress
 * bar (normal playback only), where it seeks to that point of the bar (the `progressBar`
 * role's geometry, else the video's width). Double-click → maximize / restore, pointer
 * movement → a synthetic mousemove on the video so the site shows its controls, keys →
 * Esc restores, anything else is re-dispatched to the page. Clicks also hand keyboard
 * focus back to the page, so its own shortcuts keep working.
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import { matchRole } from '../dom/query';
import type { MediaAgent } from '../media/agent';
import { scheduler } from '../schedule';
import type { PlaylistClient } from '../playlist/client';
import type { ViewService } from '../view/service';
import { createOverlayHost, type OverlayTarget } from './host';
import { DEFAULT_AD_ITEMS, type ForwardedKey } from './program';
import {
  DEFAULT_CONTROL_INSET,
  SEEK_BAND_PX,
  inSeekBand,
  isShow,
  seekFraction,
  seekTime,
  shieldRect,
  type Box,
} from './shield';

export interface OverlayController {
  /** Dev aid: show the ad overlay for `ms` without an ad. Returns false with nothing to cover. */
  preview(ms: number): boolean;
  /** Get out of the way (e.g. while the selector picker runs), then come back. */
  suspend(on: boolean): void;
}

type Mode = 'blackout' | 'ad' | 'preview' | 'shield' | 'shield-full' | 'shield-max' | null;

/** Primary media events that can change whether it counts as a show. */
const PRIMARY_EVENTS = ['loadedmetadata', 'durationchange', 'volumechange', 'play', 'emptied'] as const;
const SYNC_DELAY_MS = 100;

export function startOverlay(
  ctx: ContentScriptContext,
  agent: MediaAgent,
  ads: AdWatcher,
  view: ViewService,
  playlist: PlaylistClient,
): OverlayController {
  const { signal } = ctx;
  const overlay = createOverlayHost(signal);
  let mode: Mode = null;
  let dismissed = false;
  let previewing = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  let primaryCleanup: (() => void) | null = null;

  const adActive = () => ads.status()?.active ?? false;
  const siteHasAds = () => Boolean(agent.profile().site?.config.roles.adIndicator?.length);
  const primaryVideo = (): HTMLVideoElement | null => {
    const el = agent.primary()?.element;
    return el instanceof HTMLVideoElement && el.isConnected ? el : null;
  };

  // Only cover something that's on screen. Audio-only ads just get muted.
  const coverTarget: OverlayTarget = () => agent.primary()?.rect() ?? null;
  const shieldTarget: OverlayTarget = () => {
    const el = primaryVideo();
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (mode !== 'shield') return rect;
    return shieldRect(rect, agent.profile().site?.config.quirks?.controlBarInset ?? DEFAULT_CONTROL_INSET);
  };

  function nextMode(): Mode {
    if (suspended) return null;
    const blackout = playlist.blackout();
    if (blackout) return 'blackout';
    if (previewing) return 'preview';
    const settings = ads.settings();
    const ad = adActive();
    if (ad && settings.adOverlay && !dismissed) return 'ad';
    if (!settings.clickShield || !primaryVideo()) return null;
    if (view.mediaMaximized()) return 'shield-max';
    if (ad) return dismissed ? null : 'shield-full';
    const f = agent.primaryFeatures();
    return f && isShow(f) ? 'shield' : null;
  }

  /** Blackout content (prompt, attempts, status) changes without a mode change. */
  let blackoutShown = '';

  function sync(force = false): void {
    if (!adActive()) dismissed = false;
    const next = nextMode();
    const blackout = next === 'blackout' ? playlist.blackout() : null;
    const signature = blackout ? JSON.stringify(blackout) : '';
    if (next === mode && signature === blackoutShown && !force) return;
    mode = next;
    blackoutShown = signature;
    switch (next) {
      case 'blackout':
        overlay.show(
          {
            type: 'blackout',
            title: blackout?.title ?? null,
            prompt: blackout?.prompt ?? false,
            attempt: blackout?.attempt ?? 0,
            status: blackout?.status ?? null,
            canNext: blackout?.canNext ?? true,
          },
          () => 'viewport',
        );
        break;
      case 'ad':
      case 'preview':
        overlay.show(
          {
            type: 'ad',
            host: location.hostname,
            items: [...(playlist.ads() ?? DEFAULT_AD_ITEMS)],
            muted: next === 'ad' && ads.settings().muteAds,
          },
          coverTarget,
        );
        break;
      case 'shield':
      case 'shield-full':
      case 'shield-max':
        overlay.show(
          { type: 'shield', maximized: next === 'shield-max', seekBand: next === 'shield' ? SEEK_BAND_PX : 0 },
          shieldTarget,
        );
        break;
      default:
        overlay.hide();
    }
  }
  const syncSoon = scheduler(() => sync(), SYNC_DELAY_MS, signal);

  function progressBarRect(): Box | null {
    const matchers = agent.profile().site?.config.roles.progressBar;
    const bar = matchers ? matchRole('progressBar', matchers).match?.element : null;
    const r = bar?.getBoundingClientRect();
    return r && r.width > 0 ? r : null;
  }

  /** A click in the seek band: jump there. Returns false if it wasn't one. */
  function seekAt(x: number, y: number): boolean {
    if (mode !== 'shield') return false;
    const box = shieldTarget();
    const el = primaryVideo();
    const primary = agent.primary();
    if (!box || box === 'viewport' || !el || !primary || !inSeekBand(y, box.height, SEEK_BAND_PX)) return false;
    const bar = progressBarRect() ?? el.getBoundingClientRect();
    const ranges = el.seekable;
    const seekable = ranges.length > 0 ? { start: ranges.start(0), end: ranges.end(ranges.length - 1) } : null;
    const t = seekTime(seekFraction(box.left + x * box.width, bar), el.duration, seekable);
    if (t === null) return false;
    primary.seek(t);
    return true;
  }

  /** Let the site see the pointer move so it shows its controls. */
  function nudge(x: number, y: number): void {
    const el = primaryVideo();
    const box = shieldTarget();
    if (!el || !box || box === 'viewport') return;
    el.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: box.left + x * box.width,
        clientY: box.top + y * box.height,
      }),
    );
  }

  function forwardKey(k: ForwardedKey): void {
    if (k.key === 'Escape' && view.mediaMaximized()) {
      view.escape();
      return;
    }
    window.focus();
    const init: KeyboardEventInit = {
      key: k.key,
      code: k.code,
      shiftKey: k.shiftKey,
      ctrlKey: k.ctrlKey,
      altKey: k.altKey,
      metaKey: k.metaKey,
      repeat: k.repeat,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    const target = document.body ?? document.documentElement;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  overlay.onEvent((event) => {
    switch (event.type) {
      case 'dismiss':
        dismissed = true;
        window.focus();
        sync();
        break;
      case 'start':
        window.focus();
        playlist.start();
        break;
      case 'next':
        playlist.next();
        break;
      case 'click':
        window.focus();
        if (!seekAt(event.x, event.y)) view.togglePlayback();
        break;
      case 'dblclick': {
        // Two quick seeks in the band shouldn't also maximize.
        const box = mode === 'shield' ? shieldTarget() : null;
        if (box && box !== 'viewport' && inSeekBand(event.y, box.height, SEEK_BAND_PX)) break;
        view.toggleMaximize();
        break;
      }
      case 'activity':
        nudge(event.x, event.y);
        break;
      case 'key':
        forwardKey(event);
        break;
    }
  });

  function watchPrimary(): void {
    primaryCleanup?.();
    primaryCleanup = null;
    const el = agent.primary()?.element;
    if (!el) return;
    const controller = new AbortController();
    const opts = { passive: true, signal: AbortSignal.any([signal, controller.signal]) };
    for (const type of PRIMARY_EVENTS) el.addEventListener(type, syncSoon, opts);
    primaryCleanup = () => controller.abort();
  }

  const offAd = ads.onAdChange(() => sync());
  const offSettings = ads.onSettingsChange((settings) => {
    // Preload where ads are expected so the first one covers instantly.
    if (settings.adOverlay && siteHasAds()) overlay.preload();
    sync();
  });
  const offProfile = agent.onProfileChange(() => {
    if (ads.settings().adOverlay && siteHasAds()) overlay.preload();
    syncSoon();
  });
  const offPrimary = agent.onPrimaryChange(() => {
    watchPrimary();
    sync();
  });
  const offPlaylist = playlist.onChange(() => sync());
  const offView = view.onChange(() => {
    sync();
    // The maximized element entered the top layer after us; get back on top of it.
    overlay.restack();
  });

  ctx.onInvalidated(() => {
    offAd();
    offSettings();
    offProfile();
    offPrimary();
    offView();
    offPlaylist();
    primaryCleanup?.();
    if (previewTimer !== undefined) clearTimeout(previewTimer);
  });

  watchPrimary();
  sync();

  return {
    preview(ms) {
      if (!coverTarget()) return false;
      previewing = true;
      sync();
      if (previewTimer !== undefined) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        previewing = false;
        sync();
      }, ms);
      return true;
    },
    suspend(on) {
      suspended = on;
      if (on && previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewing = false;
      }
      sync();
    },
  };
}
