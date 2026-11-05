import { describe, expect, it } from 'vitest';
import { domainMatches, findSite, hostPermissionPatterns } from './match';

describe('domainMatches', () => {
  it('matches the domain and its subdomains', () => {
    expect(domainMatches('youtube.com', 'youtube.com')).toBe(true);
    expect(domainMatches('www.youtube.com', 'youtube.com')).toBe(true);
    expect(domainMatches('M.YouTube.com.', 'youtube.com')).toBe(true);
  });

  it('does not match lookalike domains', () => {
    expect(domainMatches('notyoutube.com', 'youtube.com')).toBe(false);
    expect(domainMatches('youtube.com.evil.net', 'youtube.com')).toBe(false);
  });
});

describe('findSite', () => {
  const sites = [
    { id: 'google.com', domains: ['google.com'] },
    { id: 'music.google.com', domains: ['music.google.com'] },
  ];

  it('prefers the most specific domain', () => {
    expect(findSite('music.google.com', sites)?.id).toBe('music.google.com');
    expect(findSite('www.google.com', sites)?.id).toBe('google.com');
  });

  it('returns undefined when nothing matches', () => {
    expect(findSite('vimeo.com', sites)).toBeUndefined();
  });
});

describe('hostPermissionPatterns', () => {
  it('produces one sorted, de-duplicated pattern per domain', () => {
    expect(
      hostPermissionPatterns([{ domains: ['youtube.com', 'youtu.be'] }, { domains: ['youtube.com'] }]),
    ).toEqual(['*://*.youtu.be/*', '*://*.youtube.com/*']);
  });
});
