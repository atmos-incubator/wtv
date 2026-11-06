/** User settings, stored in chrome.storage.local under KEYS.settings. */

export interface Settings {
  /** Mute the tab while an ad is detected. */
  muteAds: boolean;
  /** Click the site's skip button when it becomes clickable. */
  autoSkip: boolean;
  /** Cover the video with pictures / quotes while an ad plays. */
  adOverlay: boolean;
  /**
   * Click shield: clicks on the video play / pause it instead of reaching the page (no
   * accidental ad clicks). Double-click maximizes. The site's control bar stays usable.
   */
  clickShield: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  muteAds: true,
  autoSkip: true,
  adOverlay: true,
  clickShield: true,
});

/** Valid stored fields win; anything missing or malformed falls back to the default. */
export function parseSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const v = r[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}
