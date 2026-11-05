/** Storage-backed helpers around the pure override functions. */
import { KEYS, readKey, writeKey, type KVArea } from '../storage';
import {
  pruneStaleOverrides,
  validateOverrideStore,
  type OverrideStore,
  type StaleOverride,
} from './overrides';
import type { SiteConfig } from './schema';

export interface StaleOverrideNotice extends StaleOverride {
  prunedAt: number;
}

/** Keep the notice list bounded. */
const MAX_NOTICES = 50;

export async function loadOverrideStore(local: KVArea): Promise<OverrideStore> {
  const raw = await readKey<unknown>(local, KEYS.siteOverrides, undefined);
  const { store, warnings } = validateOverrideStore(raw);
  for (const w of warnings) console.warn('[wtv]', w);
  return store;
}

export async function saveOverrideStore(local: KVArea, store: OverrideStore): Promise<void> {
  await writeKey(local, KEYS.siteOverrides, store);
}

/**
 * Remove overrides whose bundled role changed in this release and record a notice for
 * each so the UI can tell the user their fix was superseded.
 */
export async function pruneStoredOverrides(
  local: KVArea,
  bundledSites: readonly SiteConfig[],
  now: number = Date.now(),
): Promise<StaleOverride[]> {
  const store = await loadOverrideStore(local);
  const { store: pruned, removed } = pruneStaleOverrides(store, bundledSites);
  if (removed.length === 0) return removed;

  await saveOverrideStore(local, pruned);
  const notices = await readKey<StaleOverrideNotice[]>(local, KEYS.staleOverrides, []);
  const next = [...notices, ...removed.map((r) => ({ ...r, prunedAt: now }))].slice(-MAX_NOTICES);
  await writeKey(local, KEYS.staleOverrides, next);
  return removed;
}
