import { describe, expect, it } from 'vitest';
import { BUNDLED_SITES } from '../sites/bundled';
import type { SiteConfig } from '../sites/schema';
import { validateSiteConfig } from '../sites/validate';
import { siteConfigToJson } from './serialize';

const config: SiteConfig = {
  schemaVersion: 1,
  id: 'example.com',
  name: 'Example',
  domains: ['example.com'],
  roles: {
    skip: [{ selector: '.skip', when: 'visible' }, { selector: '.skip-old' }],
    video: [{ selector: 'video.main' }],
  },
  quirks: { controlBarInset: 40 },
};

describe('siteConfigToJson', () => {
  it('round-trips through the validator', () => {
    const r = validateSiteConfig(JSON.parse(siteConfigToJson(config)), 'example.com');
    expect(r.ok && r.value).toEqual(config);
  });

  it('uses the shorthand for matchers without a condition and orders roles canonically', () => {
    const file = JSON.parse(siteConfigToJson(config)) as { roles: Record<string, unknown> };
    expect(Object.keys(file.roles)).toEqual(['video', 'skip']);
    expect(file.roles.skip).toEqual([{ selector: '.skip', when: 'visible' }, '.skip-old']);
  });

  it('omits empty quirks and ends with a newline', () => {
    const json = siteConfigToJson({ ...config, quirks: {} });
    expect(json.endsWith('}\n')).toBe(true);
    expect(JSON.parse(json)).not.toHaveProperty('quirks');
  });

  it('round-trips every bundled config', () => {
    for (const site of BUNDLED_SITES) {
      const r = validateSiteConfig(JSON.parse(siteConfigToJson(site)), site.id);
      expect(r.ok && r.value, site.id).toEqual(site);
    }
  });
});
