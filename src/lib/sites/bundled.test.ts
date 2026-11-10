import { describe, expect, it } from 'vitest';
import { BUNDLED_LOAD_RESULT, BUNDLED_SITES } from './bundled';
import { loadSiteConfigs } from './load';
import { hasPostSelectors } from './schema';

describe('bundled site configs (src/sites/*.json)', () => {
  it('are all valid', () => {
    expect(BUNDLED_LOAD_RESULT.errors).toEqual([]);
  });

  it('have no warnings', () => {
    expect(BUNDLED_LOAD_RESULT.warnings).toEqual([]);
  });

  it('includes at least one site', () => {
    expect(BUNDLED_SITES.length).toBeGreaterThan(0);
  });

  it('every bundled site has something to show: a video role, or post selectors', () => {
    for (const site of BUNDLED_SITES) {
      expect(Boolean(site.roles.video?.length) || hasPostSelectors(site.roles), site.id).toBe(true);
    }
  });
});

describe('loadSiteConfigs', () => {
  const site = (id: string, domains: string[]) => ({
    schemaVersion: 1,
    id,
    name: id,
    domains,
    roles: { video: ['video'] },
  });

  it('rejects two configs claiming the same domain', () => {
    const r = loadSiteConfigs({
      '/x/a.com.json': site('a.com', ['a.com', 'shared.com']),
      '/x/b.com.json': site('b.com', ['b.com', 'shared.com']),
    });
    expect(r.configs.map((c) => c.id)).toEqual(['a.com']);
    expect(r.errors.join()).toMatch(/shared\.com.*already claimed by a\.com/);
  });

  it('uses the file name as the expected id', () => {
    const r = loadSiteConfigs({ 'C:\\sites\\a.com.json': site('b.com', ['b.com']) });
    expect(r.errors.join()).toMatch(/does not match file name "a\.com"/);
  });
});
