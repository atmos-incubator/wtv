/** Extension messages (runtime / tabs messaging). */
import type { HandleKind } from './media/registry';
import type { SiteProfile } from './sites/registry';

export const MSG_STATUS = 'wtv/status';

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

export function isStatusRequest(msg: unknown): msg is StatusRequest {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === MSG_STATUS;
}
