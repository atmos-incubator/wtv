import { describe, expect, it } from 'vitest';
import { isWebUrl, originPatternForHost, webMatchPatterns } from './permissions';

describe('webMatchPatterns', () => {
  it('keeps http(s) and wildcard-scheme patterns, sorted and de-duplicated', () => {
    expect(
      webMatchPatterns([
        '*://*.youtube.com/*',
        'https://vimeo.com/*',
        'chrome-extension://abc/*',
        'file:///*',
        '*://*.youtube.com/*',
      ]),
    ).toEqual(['*://*.youtube.com/*', 'https://vimeo.com/*']);
  });
});

describe('originPatternForHost', () => {
  it('builds an exact-host pattern', () => {
    expect(originPatternForHost('Player.Vimeo.com')).toBe('*://player.vimeo.com/*');
  });
});

describe('isWebUrl', () => {
  it('accepts only http(s) URLs', () => {
    expect(isWebUrl('https://youtube.com/watch?v=x')).toBe(true);
    expect(isWebUrl('http://example.com')).toBe(true);
    expect(isWebUrl('chrome://extensions')).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
});
