/**
 * Decides what the overlay iframe shows over the primary video. Highest priority first:
 *
 *   1. Selector picker running         → nothing (suspend)
 *   2. Playlist entry loading          → blackout over the whole tab (top frame): the ad
 *                                        pictures (the entry's `[ads]`, else the site's
 *                                        images), or a notice's title ("Unavailable: …");
 *                                        then Start / Next if nothing plays
 *   2b. Page shown as a page: view=read → the article over the whole tab (top frame);
 *                             view=scroll → nothing (the page is the show)
 *   2c. A post's embedded player lifted (over its card, or filling the tab) → nothing
 *   3. Dev preview                     → ad slideshow
 *   4. Ad playing, pictures on         → ad slideshow (also the ad click shield)
 *   5. Playlist entry with view=pictures → its [show] slideshow over the media for the
 *                                        whole entry (dimmed with ⏸ while paused); the
 *                                        tab if the media has no box (audio)
 *   6. Paused show, `pausePictures` on → slideshow until it plays again (pause.ts)
 *   7. Click shield on, and the primary video is
 *        maximized                     → transparent shield over everything, idle cursor hides
 *        in an ad (pictures off)       → transparent shield over everything
 *        a show (isShow)               → transparent shield, site control bar left uncovered
 *   8. Otherwise                       → nothing
 *
 * The ad slideshow covers the site's `player` role when it has one (some ads, like YouTube's
 * static ones, move or shrink the <video> and draw outside it), else the primary video.
 * After ✕, a small "Show pictures" pill (mode `pill`) sits in the player's top-right
 * corner for the rest of the ad; it, or the popup, brings the pictures back.
 * The ✕ on the ad slideshow hides the overlay, shield included, for the rest of that ad.
 * The ad program is the playlist entry's `[ads]` block, or the default `[img]` slideshow.
 *
 * Clicks on the non-ad pictures play / pause the show (so a click on pause pictures
 * resumes it), and double-clicks maximize.
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
import { findPlayer, isPlayerFor } from '../dom/player';
import { matchRole } from '../dom/query';
import { record, timeline } from '../dev/timeline';
import { DEV_TOOLS } from '../env';
import type { MediaAgent } from '../media/agent';
import { scheduler } from '../schedule';
import type { PlaylistClient } from '../playlist/client';
import { skipKey, volumeKey } from '../view/keys';
import type { ViewService } from '../view/service';
import { createOverlayHost, type OverlayTarget } from './host';
import { PAUSE_PICTURES_DELAY_MS, pausePicturesDue } from './pause';
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
  /** For the popup: the ad pictures were hidden with ✕ during the current ad. */
  status(): OverlayStatus;
  /** Undo ✕ for the current ad. */
  showAdPictures(): void;
}

export interface OverlayStatus {
  adPicturesHidden: boolean;
}

type Mode =
  | 'blackout'
  | 'read'
  | 'ad'
  | 'pill'
  | 'preview'
  | 'show-pictures'
  | 'pause-pictures'
  | 'shield'
  | 'shield-full'
  | 'shield-max'
  | null;

/** Primary media events that can change whether it counts as a show, or is paused. */
const PRIMARY_EVENTS = [
  'loadedmetadata',
  'durationchange',
  'volumechange',
  'play',
  'pause',
  'ended',
  'seeked',
  'emptied',
] as const;
const SYNC_DELAY_MS = 100;
/** The "Show pictures" pill: size and inset from the player's top-right corner. */
const PILL = { width: 140, height: 32, inset: 12 };

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
  /** When the primary last paused (performance.now()), until it plays again. */
  let pausedAt: number | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;

  const adActive = () => ads.status()?.active ?? false;
  const siteHasAds = () => Boolean(agent.profile().site?.config.roles.adIndicator?.length);
  const primaryVideo = (): HTMLVideoElement | null => {
    const el = agent.primary()?.element;
    return el instanceof HTMLVideoElement && el.isConnected ? el : null;
  };

  let playerEl: WeakRef<Element> | null = null;
  /**
   * The site's `player` box holding the primary video, if configured and on screen.
   * Re-queried when the cached one goes away, collapses, or no longer holds the video
   * (sites move videos between players, e.g. from an inline preview to the watch page).
   */
  function playerRect(): DOMRect | null {
    const media = agent.primary()?.element ?? null;
    let el = playerEl?.deref();
    if (!el || !isPlayerFor(el, media)) {
      el = findPlayer(agent.profile().site?.config.roles.player, media) ?? undefined;
      playerEl = el ? new WeakRef(el) : null;
    }
    const r = el?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? r : null;
  }

  // Only cover something that's on screen. Audio-only ads just get muted.
  // The player box doesn't depend on which media element is primary right now, which
  // can briefly be none while the site swaps or resizes its video.
  // Maximized, the video sits in the top layer over the whole tab while the player box
  // stays where it was in the page: cover the video then.
  const coverTarget: OverlayTarget = () =>
    (view.mediaMaximized() ? null : playerRect()) ?? agent.primary()?.rect() ?? null;
  const pillTarget: OverlayTarget = () => {
    const box = coverTarget();
    if (!box || box === 'viewport') return null;
    const width = Math.min(PILL.width, box.width - 2 * PILL.inset);
    if (width < 60) return null;
    return { left: box.left + box.width - width - PILL.inset, top: box.top + PILL.inset, width, height: PILL.height };
  };
  /**
   * Pictures as the show: the media's box (or the player's), else the whole tab for media
   * that has none (audio). A video with no box right now: nothing (the host holds its place).
   */
  const showTarget: OverlayTarget = () => {
    const box = coverTarget();
    if (box) return box;
    const primary = agent.primary();
    if (!primary) return null;
    return primary.features(null).isVideo ? null : 'viewport';
  };
  const showPaused = () => {
    const primary = agent.primary();
    return primary ? !primary.features(null).playing : false;
  };

  function pauseDue(): boolean {
    const el = primaryVideo();
    const f = agent.primaryFeatures();
    if (!el || !f) return false;
    return pausePicturesDue({
      enabled: ads.settings().pausePictures,
      paused: el.paused,
      ended: el.ended,
      seeking: el.seeking,
      readyState: el.readyState,
      currentTime: el.currentTime,
      pausedForMs: pausedAt === null ? null : performance.now() - pausedAt,
      isShow: isShow(f),
      adActive: adActive(),
    });
  }

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
    const page = playlist.page();
    if (page) return page.kind === 'read' ? 'read' : null;
    // A post's embedded player is lifted (posts/embed.ts): showing anything would put the
    // overlay back on top of it.
    if (playlist.embedding()) return null;
    if (previewing) return 'preview';
    const settings = ads.settings();
    const ad = adActive();
    if (ad && settings.adOverlay) return dismissed ? 'pill' : 'ad';
    // Sticky while the entry lasts, so the site swapping its media doesn't flash the page.
    if (playlist.view() === 'pictures' && (agent.primary() || mode === 'show-pictures')) return 'show-pictures';
    if (pauseDue()) return 'pause-pictures';
    if (!settings.clickShield || !primaryVideo()) return null;
    if (view.mediaMaximized()) return 'shield-max';
    if (ad) return dismissed ? null : 'shield-full';
    const f = agent.primaryFeatures();
    return f && isShow(f) ? 'shield' : null;
  }

  /** Dev: when the ad pictures last went away, to catch them coming straight back. */
  let adLeftAt = 0;
  const BLIP_MS = 5000;

  function noteModeChange(from: Mode, to: Mode): void {
    record('overlay', `mode ${from ?? 'none'} → ${to ?? 'none'}`, {
      ad: adActive(),
      dismissed,
      suspended,
      video: Boolean(primaryVideo()),
    });
    const now = performance.now();
    if (from === 'ad') adLeftAt = now;
    if (to === 'ad' && adLeftAt && now - adLeftAt < BLIP_MS) {
      console.warn(
        `[wtv] overlay blip: the ad pictures were off for ${Math.round(now - adLeftAt)}ms. ` +
          'Recent timeline (also saved by 📸 Snapshot):',
        timeline().slice(-40),
      );
    }
  }

  /** What changes within a mode: blackout content (prompt, attempts, status), show paused. */
  let shownSignature = '';

  function sync(force = false): void {
    if (!adActive()) dismissed = false;
    const next = nextMode();
    const blackout = next === 'blackout' ? playlist.blackout() : null;
    const page = next === 'read' ? playlist.page() : null;
    const signature = blackout
      ? JSON.stringify([blackout, blackout.notice ? null : playlist.ads()])
      : next === 'show-pictures'
        ? String(showPaused())
        : page
          ? String(page.id)
          : '';
    if (next === mode && signature === shownSignature && !force) return;
    if (DEV_TOOLS && next !== mode) noteModeChange(mode, next);
    mode = next;
    shownSignature = signature;
    switch (next) {
      case 'blackout':
        overlay.show(
          {
            type: 'blackout',
            title: blackout?.title ?? null,
            pictures:
              blackout && !blackout.notice
                ? { host: location.hostname, items: [...(playlist.ads() ?? DEFAULT_AD_ITEMS)], gen: blackout.gen }
                : null,
            prompt: blackout?.prompt ?? false,
            attempt: blackout?.attempt ?? 0,
            status: blackout?.status ?? null,
            canNext: blackout?.canNext ?? true,
          },
          () => 'viewport',
        );
        break;
      case 'read':
        if (page?.kind === 'read') {
          const { id, url, html, wpm, durS } = page;
          overlay.show({ type: 'read', id, url, html, wpm, durS }, () => 'viewport');
        }
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
      case 'pill':
        overlay.show({ type: 'pill' }, pillTarget);
        break;
      case 'show-pictures':
        overlay.show(
          {
            type: 'pictures',
            purpose: 'show',
            host: location.hostname,
            items: [...(playlist.show() ?? DEFAULT_AD_ITEMS)],
            paused: showPaused(),
            slideS: null,
          },
          showTarget,
        );
        break;
      case 'pause-pictures':
        overlay.show(
          {
            type: 'pictures',
            purpose: 'pause',
            host: location.hostname,
            items: [...(playlist.ads() ?? DEFAULT_AD_ITEMS)],
            paused: true,
            slideS: ads.settings().pausePictureSeconds || null,
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
      case 'undismiss':
        dismissed = false;
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
        playlist.pointerMoved();
        nudge(event.x, event.y);
        break;
      case 'pointer':
        playlist.pointerMoved();
        break;
      case 'key': {
        // ← / → over the show: skip back / forward (not during an ad, a loading screen
        // or a page show: those have nothing to skip).
        // ↑ / ↓: volume, likewise.
        const skip = skipKey(event);
        const vol = volumeKey(event);
        const skippable = mode === 'shield' || mode === 'shield-full' || mode === 'shield-max' || mode === 'show-pictures' || mode === 'pause-pictures';
        if (skip && skippable && !adActive()) view.skip(skip);
        else if (vol && skippable && !adActive()) view.volume(vol);
        else forwardKey(event);
        break;
      }
      case 'read-started':
        playlist.pageEvent({ type: 'started', id: event.id, durationS: event.durationS });
        break;
      case 'read-failed':
        playlist.pageEvent({ type: 'failed', id: event.id });
        break;
      case 'read-done':
        playlist.pageEvent({ type: 'done', id: event.id });
        break;
    }
  });

  function clearPause(): void {
    pausedAt = null;
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    pauseTimer = undefined;
  }

  function watchPrimary(): void {
    primaryCleanup?.();
    primaryCleanup = null;
    clearPause();
    const el = agent.primary()?.element;
    if (!el) return;
    const controller = new AbortController();
    const opts = { passive: true, signal: AbortSignal.any([signal, controller.signal]) };
    for (const type of PRIMARY_EVENTS) el.addEventListener(type, syncSoon, opts);
    // Pause pictures wait a moment after the pause, and go as soon as it plays.
    el.addEventListener(
      'pause',
      () => {
        clearPause();
        pausedAt = performance.now();
        pauseTimer = setTimeout(() => {
          pauseTimer = undefined;
          sync();
        }, PAUSE_PICTURES_DELAY_MS + 50);
      },
      opts,
    );
    for (const type of ['play', 'emptied'] as const) el.addEventListener(type, clearPause, opts);
    primaryCleanup = () => {
      controller.abort();
      clearPause();
    };
  }

  const offAd = ads.onAdChange(() => sync());
  const offSettings = ads.onSettingsChange((settings) => {
    // Preload where ads are expected so the first one covers instantly.
    if (settings.adOverlay && siteHasAds()) overlay.preload();
    sync();
  });
  const offProfile = agent.onProfileChange(() => {
    playerEl = null;
    if (ads.settings().adOverlay && siteHasAds()) overlay.preload();
    syncSoon();
  });
  const offPrimary = agent.onPrimaryChange((p) => {
    record('overlay', 'primary media changed', p ? (p.rect() ? 'has a box' : 'no box') : 'none');
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
    status() {
      return { adPicturesHidden: mode === 'pill' };
    },
    showAdPictures() {
      dismissed = false;
      sync();
    },
    suspend(on) {
      suspended = on;
      playlist.suspendNav(on);
      if (on && previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewing = false;
      }
      sync();
    },
  };
}
