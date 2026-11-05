import { describe, expect, it } from 'vitest';
import {
  NO_BASE,
  pruneStaleOverrides,
  resolveSite,
  roleHash,
  validateOverrideStore,
  withRoleOverride,
  withoutRoleOverride,
  type OverrideStore,
} from './overrides';
import { profileForHost, resolveForHost } from './registry';
import type { SiteConfig } from './schema';

const bundled: SiteConfig = {
  schemaVersion: 1,
  id: 'example.com',
  name: 'Example',
  domains: ['example.com'],
  roles: {
    video: [{ selector: 'video.main' }],
    skip: [{ selector: '.skip' }],
  },
};

/** The same site after a release that changed the skip selector. */
const bundledV2: SiteConfig = {
  ...bundled,
  roles: { ...bundled.roles, skip: [{ selector: '.skip-v2' }] },
};

const fix = [{ selector: '.my-skip-fix' }];

describe('roleHash', () => {
  it('is stable regardless of key order', () => {
    const a = roleHash([{ selector: '.a', when: 'visible' }]);
    const b = roleHash([JSON.parse('{"when":"visible","selector":".a"}')]);
    expect(a).toBe(b);
  });

  it('is order-sensitive across matchers', () => {
    expect(roleHash([{ selector: '.a' }, { selector: '.b' }])).not.toBe(
      roleHash([{ selector: '.b' }, { selector: '.a' }]),
    );
  });

  it('returns NO_BASE for missing or empty roles', () => {
    expect(roleHash(undefined)).toBe(NO_BASE);
    expect(roleHash([])).toBe(NO_BASE);
  });
});

describe('resolveSite', () => {
  it('uses bundled roles when there is no override', () => {
    const r = resolveSite('example.com', bundled, undefined);
    expect(r?.config.roles.skip).toEqual([{ selector: '.skip' }]);
    expect(r?.sources).toEqual({ video: 'bundled', skip: 'bundled' });
  });

  it('applies an override while the bundled role is unchanged', () => {
    const store = withRoleOverride({}, bundled, 'example.com', 'skip', fix, {}, 1);
    const r = resolveSite('example.com', bundled, store['example.com']);
    expect(r?.config.roles.skip).toEqual(fix);
    expect(r?.sources.skip).toBe('override');
    expect(r?.sources.video).toBe('bundled');
    expect(r?.stale).toEqual([]);
  });

  it('lets a release that changed the role win over the old override', () => {
    const store = withRoleOverride({}, bundled, 'example.com', 'skip', fix, {}, 1);
    const r = resolveSite('example.com', bundledV2, store['example.com']);
    expect(r?.config.roles.skip).toEqual([{ selector: '.skip-v2' }]);
    expect(r?.stale).toEqual([{ siteId: 'example.com', role: 'skip', savedAt: 1 }]);
  });

  it('keeps overrides on other roles when an unrelated role changes', () => {
    const store = withRoleOverride({}, bundled, 'example.com', 'video', fix, {}, 1);
    const r = resolveSite('example.com', bundledV2, store['example.com']);
    expect(r?.config.roles.video).toEqual(fix);
    expect(r?.stale).toEqual([]);
  });

  it('adds a role the bundled config lacks, until a release adds it', () => {
    const store = withRoleOverride({}, bundled, 'example.com', 'title', [{ selector: 'h1' }], {}, 1);
    expect(store['example.com']?.roles.title?.baseHash).toBe(NO_BASE);
    expect(resolveSite('example.com', bundled, store['example.com'])?.sources.title).toBe('override');

    const withTitle: SiteConfig = { ...bundled, roles: { ...bundled.roles, title: [{ selector: 'h2' }] } };
    const r = resolveSite('example.com', withTitle, store['example.com']);
    expect(r?.config.roles.title).toEqual([{ selector: 'h2' }]);
    expect(r?.stale).toHaveLength(1);
  });

  it('does not mutate the bundled config', () => {
    const store = withRoleOverride({}, bundled, 'example.com', 'skip', fix, {}, 1);
    resolveSite('example.com', bundled, store['example.com']);
    expect(bundled.roles.skip).toEqual([{ selector: '.skip' }]);
  });

  it('builds a user-defined site from an override with domains', () => {
    const store = withRoleOverride({}, undefined, 'vimeo.com', 'video', fix, {
      name: 'Vimeo',
      domains: ['vimeo.com'],
    });
    const r = resolveSite('vimeo.com', undefined, store['vimeo.com']);
    expect(r?.userDefined).toBe(true);
    expect(r?.config.name).toBe('Vimeo');
    expect(r?.config.roles.video).toEqual(fix);
  });

  it('returns undefined for an override without bundled config or domains', () => {
    const store = withRoleOverride({}, undefined, 'vimeo.com', 'video', fix);
    expect(resolveSite('vimeo.com', undefined, store['vimeo.com'])).toBeUndefined();
  });
});

describe('store editing', () => {
  it('withoutRoleOverride removes the role and empty sites', () => {
    let store = withRoleOverride({}, bundled, 'example.com', 'skip', fix);
    store = withoutRoleOverride(store, 'example.com', 'skip');
    expect(store).toEqual({});
  });

  it('withRoleOverride does not clobber a user-defined site name when omitted', () => {
    let store = withRoleOverride({}, undefined, 'vimeo.com', 'video', fix, {
      name: 'Vimeo',
      domains: ['vimeo.com'],
    });
    store = withRoleOverride(store, undefined, 'vimeo.com', 'skip', fix);
    expect(store['vimeo.com']?.name).toBe('Vimeo');
    expect(store['vimeo.com']?.domains).toEqual(['vimeo.com']);
  });
});

describe('pruneStaleOverrides', () => {
  it('removes stale roles and reports them', () => {
    let store = withRoleOverride({}, bundled, 'example.com', 'skip', fix, {}, 1);
    store = withRoleOverride(store, bundled, 'example.com', 'video', fix, {}, 2);
    const { store: pruned, removed } = pruneStaleOverrides(store, [bundledV2]);
    expect(removed).toEqual([{ siteId: 'example.com', role: 'skip', savedAt: 1 }]);
    expect(Object.keys(pruned['example.com']?.roles ?? {})).toEqual(['video']);
  });

  it('removes a site entirely when all of its overrides are stale', () => {
    const store = withRoleOverride({}, bundled, 'example.com', 'skip', fix, {}, 1);
    expect(pruneStaleOverrides(store, [bundledV2]).store).toEqual({});
  });

  it('keeps user-defined sites', () => {
    const store = withRoleOverride({}, undefined, 'vimeo.com', 'video', fix, { domains: ['vimeo.com'] });
    expect(pruneStaleOverrides(store, [bundled]).store).toEqual(store);
  });
});

describe('validateOverrideStore', () => {
  it('round-trips a valid store', () => {
    const store = withRoleOverride({}, bundled, 'example.com', 'skip', fix, {}, 1);
    expect(validateOverrideStore(JSON.parse(JSON.stringify(store))).store).toEqual(store);
  });

  it('drops invalid entries with warnings instead of failing', () => {
    const { store, warnings } = validateOverrideStore({
      'bad id!': { roles: {} },
      'example.com': {
        roles: {
          skip: { matchers: [''], baseHash: 'x', savedAt: 1 },
          nope: { matchers: ['.a'], baseHash: 'x', savedAt: 1 },
          video: { matchers: ['.ok'], baseHash: 'x', savedAt: 1 },
        },
      },
    });
    expect(Object.keys(store)).toEqual(['example.com']);
    expect(Object.keys(store['example.com']?.roles ?? {})).toEqual(['video']);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('treats a non-object as empty', () => {
    expect(validateOverrideStore('garbage').store).toEqual({});
    expect(validateOverrideStore(undefined).store).toEqual({});
  });
});

describe('resolveForHost', () => {
  const store: OverrideStore = withRoleOverride({}, undefined, 'vimeo.com', 'video', fix, {
    domains: ['vimeo.com'],
  });

  it('resolves bundled sites by hostname', () => {
    expect(resolveForHost('www.example.com', [bundled], store)?.config.id).toBe('example.com');
  });

  it('resolves user-defined sites by hostname', () => {
    expect(resolveForHost('player.vimeo.com', [bundled], store)?.userDefined).toBe(true);
  });

  it('returns undefined for unknown hosts', () => {
    expect(resolveForHost('twitch.tv', [bundled], store)).toBeUndefined();
  });
});

describe('profileForHost', () => {
  const store: OverrideStore = withRoleOverride({}, undefined, 'vimeo.com', 'video', fix, {
    domains: ['vimeo.com'],
  });

  it('classifies bundled, user-defined and generic hosts', () => {
    expect(profileForHost('www.example.com', [bundled], store).kind).toBe('bundled');
    expect(profileForHost('vimeo.com', [bundled], store).kind).toBe('user');
    const generic = profileForHost('twitch.tv', [bundled], store);
    expect(generic).toEqual({ kind: 'generic', site: null });
  });
});
