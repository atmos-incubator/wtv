/** Extension messages (runtime / tabs messaging). */
import type { AdProbe } from './ads/probe';
import type { HandleKind } from './media/registry';
import type { SiteProfile } from './sites/registry';

export const MSG_STATUS = 'wtv/status';
/** Popup → every frame of a tab: bring back the ad pictures hidden with ✕. */
export const MSG_SHOW_AD_PICTURES = 'wtv/show-ad-pictures';
/** Dev builds only: show the ad overlay for a few seconds without an ad. */
export const MSG_PREVIEW_OVERLAY = 'wtv/dev-preview-overlay';

export interface StatusRequest {
  type: typeof MSG_STATUS;
}

export interface PrimaryStatus {
  key: string;
  kind: HandleKind;
  isVideo: boolean;
  /** Whether the site config's `video` role picked it, or heuristics alone. */
  source: 'config' | 'heuristic';
  score: number;
  playing: boolean;
  muted: boolean;
  /** Seconds; null when unknown. */
  duration: number | null;
  live: boolean;
}

export interface MediaStatus {
  profile: { kind: SiteProfile['kind']; siteId: string | null; name: string | null };
  primary: PrimaryStatus | null;
  candidates: number;
  /**
   * Media is playing and the site config has a `video` role, but none of its selectors
   * found a media element: an early "selectors may be broken" signal.
   */
  configVideoMissing: boolean;
  selectorErrors: string[];
}

export interface AdStatus {
  /** An ad is showing right now (including the short grace period after it ends). */
  active: boolean;
  muteAds: boolean;
  autoSkip: boolean;
  /** Skip-button clicks since the page loaded. */
  skipClicks: number;
  /** Skippable ads skipped by seeking to their end, because the Skip click was ignored. */
  skipSeeks: number;
  /** The latest ad probe (what's where the show was) during the current or last ad. */
  probe: AdProbe | null;
  /** The click strategy that last made a Skip button go away (see dom/click.ts). */
  skipWorked: string | null;
  /** Recent skip attempts and outcomes, oldest first. */
  skipLog: string[];
  selectorErrors: string[];
}

/** One frame's answer to MSG_STATUS. `ads` is null when the site has no adIndicator role. */
export interface FrameStatus {
  media: MediaStatus;
  ads: AdStatus | null;
  overlay: { adPicturesHidden: boolean };
}

export function isStatusRequest(msg: unknown): msg is StatusRequest {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === MSG_STATUS;
}
