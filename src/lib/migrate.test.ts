import { describe, expect, it } from 'vitest';
import { runMigrations, type Migration } from './migrate';
import { KEYS } from './storage';
import { createMemoryArea } from './testing/memory-area';

const update = { reason: 'update', previousVersion: '1.4.2' };

describe('runMigrations', () => {
  it('stamps the schema version on a fresh install', async () => {
    const local = createMemoryArea();
    const sync = createMemoryArea();
    const report = await runMigrations({ local, sync }, { reason: 'install' });
    expect(report).toEqual({ action: 'fresh', to: 1 });
    expect(local.dump()).toEqual({ [KEYS.schemaVersion]: 1 });
  });

  it('clears the previous extension data', async () => {
    const local = createMemoryArea({ playlists: ['a', 'b'], settings: { volume: 3 } });
    const sync = createMemoryArea({ prefs: { theme: 'dark' } });
    const report = await runMigrations({ local, sync }, update);

    expect(report).toEqual({
      action: 'legacy-cleared',
      to: 1,
      fromVersion: '1.4.2',
      localKeys: ['playlists', 'settings'],
      syncKeys: ['prefs'],
    });
    expect(local.dump()).toEqual({ [KEYS.schemaVersion]: 1 });
    expect(sync.dump()).toEqual({});
  });

  it('is idempotent', async () => {
    const local = createMemoryArea({ old: 1 });
    const sync = createMemoryArea();
    await runMigrations({ local, sync }, update);
    await local.set({ [KEYS.siteOverrides]: { kept: true } });
    const snapshot = local.dump();
    const report = await runMigrations({ local, sync }, update);
    expect(report).toEqual({ action: 'current', to: 1 });
    expect(local.dump()).toEqual(snapshot);
  });

  it('runs pending steps in order and checkpoints the version', async () => {
    const local = createMemoryArea({ [KEYS.schemaVersion]: 1 });
    const sync = createMemoryArea();
    const ran: number[] = [];
    const step = (to: number): Migration => ({
      to,
      description: `to ${to}`,
      run: async () => {
        ran.push(to);
        expect(local.dump()[KEYS.schemaVersion]).toBe(to - 1);
      },
    });
    const report = await runMigrations({ local, sync }, update, {
      currentVersion: 3,
      migrations: [step(3), step(2), step(1)],
    });
    expect(ran).toEqual([2, 3]);
    expect(report).toEqual({ action: 'migrated', from: 1, to: 3, steps: ['to 2', 'to 3'] });
    expect(local.dump()[KEYS.schemaVersion]).toBe(3);
  });

  it('leaves newer data untouched on downgrade', async () => {
    const local = createMemoryArea({ [KEYS.schemaVersion]: 9, [KEYS.siteOverrides]: { x: 1 } });
    const sync = createMemoryArea();
    const before = local.dump();
    const report = await runMigrations({ local, sync }, update);
    expect(report).toEqual({ action: 'downgrade', from: 9, to: 1 });
    expect(local.dump()).toEqual(before);
  });
});
