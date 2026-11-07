/**
 * Minimal key/value interface over chrome.storage areas. Lib code depends on this, not on
 * the `browser` global, so it runs in plain unit tests with an in-memory area.
 * Use browser-storage.ts to get the real areas in extension contexts.
 */
export interface KVArea {
  /** `null` returns everything in the area. */
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface StorageAreas {
  local: KVArea;
  sync: KVArea;
  session: KVArea;
}

/** All Wtv keys are prefixed `wtv.` so they can't be confused with the old extension's data. */
export const KEY_PREFIX = 'wtv.';

export const KEYS = {
  /** number: storage schema version (see migrate.ts). */
  schemaVersion: 'wtv.schemaVersion',
  /** OverrideStore: per-site, per-role selector overrides. */
  siteOverrides: 'wtv.siteOverrides',
  /** StaleOverrideNotice[]: overrides pruned because a release changed that role. */
  staleOverrides: 'wtv.staleOverrides',
  /** Settings (local). */
  settings: 'wtv.settings',
  /** Record<tabId, TabMuteState> (session): survives service-worker restarts mid-ad. */
  adMute: 'wtv.adMute',
  /** Record<tabId, true> (session): tabs muted with Wtv's own mute command, so ad logic leaves them muted. */
  userMute: 'wtv.userMute',
  /** HealthStore (local): per-site player-role check streaks (src/lib/health/health.ts). */
  siteHealth: 'wtv.siteHealth',
  /** PlaylistStore (local): saved playlists, as text. */
  playlists: 'wtv.playlists',
  /** PlaylistPlays (local): when each playlist last started playing (src/lib/playlist/explore.ts). */
  playlistPlays: 'wtv.playlistPlays',
  /** Record<tabId, RunnerState> (session): playlists playing, one per tab. */
  runner: 'wtv.runner',
  /** Record<tabId, TvState> (session): tabs in TV mode (fullscreen window + maximized video). */
  tvMode: 'wtv.tvMode',
} as const;

export async function readKey<T>(area: KVArea, key: string, fallback: T): Promise<T> {
  const result = await area.get(key);
  return key in result ? (result[key] as T) : fallback;
}

export async function writeKey(area: KVArea, key: string, value: unknown): Promise<void> {
  await area.set({ [key]: value });
}
