/**
 * Backup / restore: playlists, selector overrides and settings in one JSON file. Pure;
 * the playlists page reads and writes storage around it.
 *
 *   { "format": "wtv-backup", "version": 1, "exportedAt": "…",
 *     "playlists": [StoredPlaylist…], "overrides": OverrideStore, "settings": Settings }
 *
 * Import is a merge, shown to the user before anything is written:
 *   - playlists by id: new ones are added, ones with the same id are replaced (when they
 *     differ), the rest are left alone. Built-in ids are never imported.
 *   - selector overrides per site and role: the backup's win, other roles stay.
 *   - settings: the backup's replace the current ones.
 * Everything is validated; anything malformed is dropped with a warning, never written.
 * The image library isn't included: it's re-imported from its folder.
 */
import { isBuiltinId } from './playlist/builtin';
import { cleanName, isPlaylist, type PlaylistStore, type StoredPlaylist } from './playlist/store';
import { parseSettings, type Settings } from './settings';
import { validateOverrideStore, type OverrideStore } from './sites/overrides';

export const BACKUP_FORMAT = 'wtv-backup';
export const BACKUP_VERSION = 1;
/** Far more than any real playlist; keeps a hostile file from filling storage. */
const MAX_PLAYLIST_TEXT = 1_000_000;
const MAX_PLAYLISTS = 2000;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  playlists: StoredPlaylist[];
  overrides: OverrideStore;
  settings: Settings;
}

export interface WtvState {
  playlists: PlaylistStore;
  overrides: OverrideStore;
  settings: Settings;
}

export function makeBackup(state: WtvState, now = new Date()): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    playlists: Object.values(state.playlists).sort((a, b) => a.name.localeCompare(b.name)),
    overrides: state.overrides,
    settings: state.settings,
  };
}

export function backupFileName(now = new Date()): string {
  return `wtv-backup-${now.toISOString().slice(0, 10)}.json`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type ParsedBackup = { ok: true; backup: Backup; warnings: string[] } | { ok: false; error: string };

export function parseBackup(raw: unknown): ParsedBackup {
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT) return { ok: false, error: 'This isn’t a Wtv backup file.' };
  if (raw.version !== BACKUP_VERSION) {
    return { ok: false, error: `This backup is version ${String(raw.version)}; this Wtv reads version ${BACKUP_VERSION}.` };
  }
  const warnings: string[] = [];
  const playlists: StoredPlaylist[] = [];
  const seen = new Set<string>();
  const rawPlaylists = Array.isArray(raw.playlists) ? raw.playlists : [];
  if (!Array.isArray(raw.playlists)) warnings.push('No playlist list in the file.');
  for (const [i, p] of rawPlaylists.slice(0, MAX_PLAYLISTS).entries()) {
    const id = isObj(p) && typeof p.id === 'string' ? p.id : '';
    if (!id || !isPlaylist(p, id)) warnings.push(`Playlist #${i + 1}: malformed, skipped.`);
    else if (isBuiltinId(id)) warnings.push(`“${p.name}”: a built-in playlist, skipped.`);
    else if (seen.has(id)) warnings.push(`“${p.name}”: listed twice, the second copy skipped.`);
    else if (p.text.length > MAX_PLAYLIST_TEXT) warnings.push(`“${p.name}”: too long, skipped.`);
    else {
      seen.add(id);
      playlists.push({ id, name: cleanName(p.name) || 'Imported playlist', text: p.text, createdAt: p.createdAt, updatedAt: p.updatedAt });
    }
  }
  if (rawPlaylists.length > MAX_PLAYLISTS) warnings.push(`Only the first ${MAX_PLAYLISTS} playlists were read.`);
  const { store: overrides, warnings: overrideWarnings } = validateOverrideStore(raw.overrides);
  warnings.push(...overrideWarnings.map((w) => `Selector ${w}`));
  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      playlists,
      overrides,
      settings: parseSettings(raw.settings),
    },
    warnings,
  };
}

export interface ImportPlan {
  added: string[];
  replaced: string[];
  unchanged: number;
  /** "youtube.com: title, creator". */
  overrides: string[];
  settingsChanged: boolean;
  next: WtvState;
}

export function planImport(current: WtvState, backup: Backup): ImportPlan {
  const playlists: PlaylistStore = { ...current.playlists };
  const added: string[] = [];
  const replaced: string[] = [];
  let unchanged = 0;
  for (const p of backup.playlists) {
    const old = playlists[p.id];
    if (!old) added.push(p.name);
    else if (old.name !== p.name || old.text !== p.text) replaced.push(old.name === p.name ? p.name : `${old.name} → ${p.name}`);
    else {
      unchanged++;
      continue;
    }
    playlists[p.id] = p;
  }

  const overrides: OverrideStore = { ...current.overrides };
  const overrideNotes: string[] = [];
  for (const [siteId, site] of Object.entries(backup.overrides)) {
    const before = overrides[siteId];
    overrides[siteId] = { ...before, ...site, roles: { ...before?.roles, ...site.roles } };
    overrideNotes.push(`${siteId}: ${Object.keys(site.roles).join(', ')}`);
  }

  const settingsChanged = (Object.keys(backup.settings) as (keyof Settings)[]).some(
    (k) => backup.settings[k] !== current.settings[k],
  );
  return {
    added,
    replaced,
    unchanged,
    overrides: overrideNotes,
    settingsChanged,
    next: { playlists, overrides, settings: backup.settings },
  };
}

const quoteList = (names: readonly string[]) => names.map((n) => `“${n}”`).join(', ');

/** The confirm text: what the import will change. */
export function describePlan(plan: ImportPlan): string {
  const lines: string[] = [];
  if (plan.added.length) lines.push(`Add ${plan.added.length} playlist(s): ${quoteList(plan.added)}`);
  if (plan.replaced.length) lines.push(`Replace ${plan.replaced.length} playlist(s) with the backup’s copy: ${quoteList(plan.replaced)}`);
  if (plan.unchanged) lines.push(`${plan.unchanged} playlist(s) already match the backup.`);
  if (plan.overrides.length) lines.push(`Use the backup’s selectors for ${plan.overrides.join('; ')}`);
  if (plan.settingsChanged) lines.push('Replace your settings with the backup’s.');
  return lines.length ? lines.join('\n') : 'Nothing to change: everything already matches the backup.';
}

export function planChangesAnything(plan: ImportPlan): boolean {
  return plan.added.length + plan.replaced.length + plan.overrides.length > 0 || plan.settingsChanged;
}
