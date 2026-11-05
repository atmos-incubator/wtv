import { describe, expect, it } from 'vitest';
import { KEYS } from '../storage';
import { createMemoryArea } from '../testing/memory-area';
import { withRoleOverride } from './overrides';
import { loadOverrideStore, pruneStoredOverrides } from './override-store';
import type { SiteConfig } from './schema';

const v1: SiteConfig = {
  schemaVersion: 1,
  id: 'example.com',
  name: 'Example',
  domains: ['example.com'],
  roles: { skip: [{ selector: '.skip' }] },
};
const v2: SiteConfig = { ...v1, roles: { skip: [{ selector: '.skip-v2' }] } };

describe('pruneStoredOverrides', () => {
  it('removes superseded overrides and records notices', async () => {
    const store = withRoleOverride({}, v1, 'example.com', 'skip', [{ selector: '.fix' }], {}, 5);
    const local = createMemoryArea({ [KEYS.siteOverrides]: store });

    const removed = await pruneStoredOverrides(local, [v2], 100);

    expect(removed).toEqual([{ siteId: 'example.com', role: 'skip', savedAt: 5 }]);
    expect(await loadOverrideStore(local)).toEqual({});
    expect(local.dump()[KEYS.staleOverrides]).toEqual([
      { siteId: 'example.com', role: 'skip', savedAt: 5, prunedAt: 100 },
    ]);
  });

  it('writes nothing when overrides are still current', async () => {
    const store = withRoleOverride({}, v1, 'example.com', 'skip', [{ selector: '.fix' }], {}, 5);
    const local = createMemoryArea({ [KEYS.siteOverrides]: store });
    expect(await pruneStoredOverrides(local, [v1], 100)).toEqual([]);
    expect(local.dump()[KEYS.staleOverrides]).toBeUndefined();
  });
});
