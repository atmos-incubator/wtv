/**
 * Dev builds only: the hosts the 📸 Snapshot button is turned on for (popup → Dev), as a
 * string[] in storage.local. Kept out of KEYS so the store build has no trace of it.
 */
export const SNAPSHOT_HOSTS_KEY = 'wtv.dev.snapshotHosts';

export function parseSnapshotHosts(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string') : [];
}
