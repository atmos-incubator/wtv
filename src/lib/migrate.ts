/**
 * Storage schema migrations, run from runtime.onInstalled.
 *
 * - No `wtv.schemaVersion` and empty storage → fresh install, stamp current version.
 * - No `wtv.schemaVersion` but data present → data from the previous (pre-rewrite)
 *   extension. Copy it all into `wtv.legacyBackup` first, then remove the old keys.
 *   Nothing is lost; a later step can import from the backup.
 * - Older version → run each Migration step in order, checkpointing after each.
 * - Newer version (downgrade) → leave everything untouched.
 *
 * Idempotent: safe to run on every onInstalled event.
 */
import { KEYS, readKey, writeKey, type StorageAreas } from './storage';

export const CURRENT_SCHEMA_VERSION = 1;

export type MigrationAreas = Pick<StorageAreas, 'local' | 'sync'>;

export interface Migration {
  /** Schema version after this step runs. */
  to: number;
  description: string;
  run(areas: MigrationAreas): Promise<void>;
}

/** Add steps here when the storage schema changes. */
export const MIGRATIONS: readonly Migration[] = [];

export interface InstallDetails {
  reason: string;
  previousVersion?: string;
}

export interface LegacyBackup {
  fromVersion: string | null;
  savedAt: number;
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
}

export type MigrationReport =
  | { action: 'fresh'; to: number }
  | { action: 'legacy-backup'; to: number; localKeys: string[]; syncKeys: string[] }
  | { action: 'migrated'; from: number; to: number; steps: string[] }
  | { action: 'current'; to: number }
  | { action: 'downgrade'; from: number; to: number };

export interface MigrationOptions {
  now?: number;
  migrations?: readonly Migration[];
  currentVersion?: number;
}

export async function runMigrations(
  areas: MigrationAreas,
  details: InstallDetails,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const current = options.currentVersion ?? CURRENT_SCHEMA_VERSION;
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.to - b.to);
  const stored = await readKey<unknown>(areas.local, KEYS.schemaVersion, undefined);

  if (typeof stored === 'number') {
    if (stored === current) return { action: 'current', to: current };
    if (stored > current) return { action: 'downgrade', from: stored, to: current };

    const steps: string[] = [];
    for (const m of migrations) {
      if (m.to <= stored || m.to > current) continue;
      await m.run(areas);
      await writeKey(areas.local, KEYS.schemaVersion, m.to);
      steps.push(m.description);
    }
    await writeKey(areas.local, KEYS.schemaVersion, current);
    return { action: 'migrated', from: stored, to: current, steps };
  }

  const local = await areas.local.get(null);
  const sync = await areas.sync.get(null);
  const localKeys = Object.keys(local);
  const syncKeys = Object.keys(sync);

  if (localKeys.length === 0 && syncKeys.length === 0) {
    await writeKey(areas.local, KEYS.schemaVersion, current);
    return { action: 'fresh', to: current };
  }

  // Back up before removing anything. If this write fails (quota), we throw and leave
  // the old data in place.
  const backup: LegacyBackup = {
    fromVersion: details.previousVersion ?? null,
    savedAt: options.now ?? Date.now(),
    local,
    sync,
  };
  await writeKey(areas.local, KEYS.legacyBackup, backup);

  const localToRemove = localKeys.filter((k) => k !== KEYS.legacyBackup);
  if (localToRemove.length > 0) await areas.local.remove(localToRemove);
  if (syncKeys.length > 0) await areas.sync.remove(syncKeys);

  await writeKey(areas.local, KEYS.schemaVersion, current);
  return { action: 'legacy-backup', to: current, localKeys: localToRemove, syncKeys };
}
