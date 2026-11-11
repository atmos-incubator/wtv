import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings } from './settings';

describe('parseSettings', () => {
  it('returns defaults for missing or garbage input', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid stored values and drops malformed ones', () => {
    expect(parseSettings({ muteAds: false, autoSkip: 'yes', extra: 1 })).toEqual({
      muteAds: false,
      autoSkip: true,
      adOverlay: true,
      clickShield: true,
      pausePictures: false,
      defaultImageFolder: '',
    });
  });

  it('keeps the default picture folder as the library names folders', () => {
    expect(parseSettings({ defaultImageFolder: '  TV ' }).defaultImageFolder).toBe('tv');
    expect(parseSettings({ defaultImageFolder: 3 }).defaultImageFolder).toBe('');
  });

  it('does not mutate the defaults', () => {
    parseSettings({ muteAds: false });
    expect(DEFAULT_SETTINGS.muteAds).toBe(true);
  });
});
