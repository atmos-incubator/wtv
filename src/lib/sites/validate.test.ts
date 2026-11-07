import { describe, expect, it } from 'vitest';
import { validateSiteConfig } from './validate';

const base = {
  schemaVersion: 1,
  id: 'example.com',
  name: 'Example',
  domains: ['example.com'],
  roles: { video: ['video.main'] },
};

describe('validateSiteConfig', () => {
  it('accepts a minimal config and normalizes shorthand selectors', () => {
    const r = validateSiteConfig(base, 'example.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.roles.video).toEqual([{ selector: 'video.main' }]);
  });

  it('keeps explicit when and trims selectors', () => {
    const r = validateSiteConfig({
      ...base,
      roles: { adIndicator: [{ selector: '  .ad  ', when: 'exists' }] },
    });
    expect(r.ok && r.value.roles.adIndicator).toEqual([{ selector: '.ad', when: 'exists' }]);
  });

  it('accepts shadow-piercing selectors', () => {
    const r = validateSiteConfig({ ...base, roles: { video: ['app-root >>> video'] } });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['empty shadow segment', { roles: { video: ['app-root >>> '] } }],
    ['empty selector', { roles: { video: [''] } }],
    ['bad when', { roles: { video: [{ selector: 'video', when: 'hover' }] } }],
    ['unknown role', { roles: { vidoe: ['video'] } }],
    ['roles not an object', { roles: [] }],
    ['wrong schema version', { schemaVersion: 2 }],
    ['domain with scheme', { domains: ['https://example.com'] }],
    ['wildcard domain', { domains: ['*.example.com'] }],
    ['uppercase domain', { domains: ['Example.com'] }],
    ['no domains', { domains: [] }],
    ['duplicate domain', { domains: ['example.com', 'example.com'] }],
    ['missing name', { name: ' ' }],
    ['negative control bar inset', { quirks: { controlBarInset: -1 } }],
    ['non-boolean adsInMainVideo', { quirks: { adsInMainVideo: 'yes' } }],
    ['thumbnail hosts that are not a list', { thumbnailHosts: 'i.ytimg.com' }],
    ['a thumbnail host with a scheme', { thumbnailHosts: ['https://i.ytimg.com'] }],
  ])('rejects %s', (_label, patch) => {
    const r = validateSiteConfig({ ...base, ...patch });
    expect(r.ok).toBe(false);
  });

  it('rejects an id that does not match the file name', () => {
    const r = validateSiteConfig(base, 'other.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/does not match file name/);
  });

  it('drops duplicate selectors with a warning', () => {
    const r = validateSiteConfig({ ...base, roles: { video: ['video', 'video'] } });
    expect(r.ok && r.value.roles.video).toHaveLength(1);
    expect(r.warnings.join()).toMatch(/duplicate/);
  });

  it('keeps known quirks', () => {
    const r = validateSiteConfig({ ...base, quirks: { controlBarInset: 48, adsInMainVideo: true } });
    expect(r.ok && r.value.quirks).toEqual({ controlBarInset: 48, adsInMainVideo: true });
  });

  it('keeps thumbnail hosts, deduplicated', () => {
    const r = validateSiteConfig({ ...base, thumbnailHosts: ['i.ytimg.com', 'i.ytimg.com'] });
    expect(r.ok && r.value.thumbnailHosts).toEqual(['i.ytimg.com']);
  });

  it('warns on unknown keys without failing', () => {
    const r = validateSiteConfig({ ...base, extra: true, quirks: { future: 1 } });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(2);
  });
});
