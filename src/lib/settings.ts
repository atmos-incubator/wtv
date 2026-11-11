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
  /** Cover the show with pictures while it's paused (by the user, not buffering). */
  pausePictures: boolean;
  /**
   * Keyword folder (lowercase) whose pictures `[img]` with no keyword shows, before
   * top-level files; '' for none. See images/library.ts resolveImages.
   */
  defaultImageFolder: string;
}

/** The on / off settings (the popup's switches). */
export type SettingSwitch = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  muteAds: true,
  autoSkip: true,
  adOverlay: true,
  clickShield: true,
  pausePictures: false,
  defaultImageFolder: '',
});

/** A keyword folder name as the library keeps it: trimmed, lowercase. */
export function normalizeFolderName(name: string): string {
  return name.trim().toLowerCase().slice(0, 200);
}

/** Valid stored fields win; anything missing or malformed falls back to the default. */
export function parseSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingSwitch[]) {
    const v = r[key];
    if (typeof DEFAULT_SETTINGS[key] === 'boolean' && typeof v === 'boolean') out[key] = v;
  }
  if (typeof r.defaultImageFolder === 'string') out.defaultImageFolder = normalizeFolderName(r.defaultImageFolder);
  return out;
}
