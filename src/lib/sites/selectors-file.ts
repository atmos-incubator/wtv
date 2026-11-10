/**
 * Every site's saved selectors in one file, to move them to another computer or (dev builds)
 * into the repo's src/sites/. Pure; the side panel reads and writes around it.
 *
 *   { "format": "wtv-selectors", "version": 1, "exportedAt": "…", "sites": OverrideStore }
 *
 * `sites` is the override store as kept in storage: per site, `roles` (each `matchers`, plus
 * `baseHash`, the built-in selectors it was saved over, and `savedAt`), `quirks`, and for
 * sites Wtv doesn't know, `name` and `domains`. To leave something out of an import or a
 * repo write, delete it from the file.
 *
 * Import (planSelectorsImport) merges per site and role, the file's winning. A role saved
 * over other built-in selectors than this Wtv has is skipped: it wouldn't apply here.
 *
 * Repo write (planRepoWrite) layers the file over the repo's own site files, the way the
 * extension layers overrides over its built-in configs, and gives the new file texts. Roles
 * saved over other selectors than the repo now has are skipped (redo them), and nothing is
 * written if the build would then fail.
 */
import { BACKUP_FORMAT } from '../backup';
import { siteConfigToJson } from '../picker/serialize';
import { loadSiteConfigs } from './load';
import { isOverrideCurrent, resolveSite, roleHash, validateOverrideStore, type OverrideStore, type SiteOverride } from './overrides';
import { USER_QUIRKS, type RoleName, type SiteConfig, type UserQuirk } from './schema';

export const SELECTORS_FORMAT = 'wtv-selectors';
export const SELECTORS_VERSION = 1;

export interface SelectorsFile {
  format: typeof SELECTORS_FORMAT;
  version: typeof SELECTORS_VERSION;
  exportedAt: string;
  sites: OverrideStore;
}

export function makeSelectorsFile(store: OverrideStore, now = new Date()): SelectorsFile {
  const sites: OverrideStore = {};
  for (const id of Object.keys(store).sort()) sites[id] = store[id]!;
  return { format: SELECTORS_FORMAT, version: SELECTORS_VERSION, exportedAt: now.toISOString(), sites };
}

export function selectorsFileName(now = new Date()): string {
  return `wtv-selectors-${now.toISOString().slice(0, 10)}.json`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type ParsedSelectorsFile = { ok: true; sites: OverrideStore; warnings: string[] } | { ok: false; error: string };

/** A selectors file, or a full backup (its selectors). */
export function parseSelectorsFile(raw: unknown): ParsedSelectorsFile {
  if (!isObj(raw)) return { ok: false, error: 'This isn’t a Wtv selectors file.' };
  const backup = raw.format === BACKUP_FORMAT;
  if (!backup && raw.format !== SELECTORS_FORMAT) return { ok: false, error: 'This isn’t a Wtv selectors file (or backup).' };
  if (raw.version !== 1) return { ok: false, error: `This file is version ${String(raw.version)}; this Wtv reads version 1.` };
  const { store, warnings } = validateOverrideStore(backup ? raw.overrides : raw.sites);
  if (!backup && raw.sites === undefined) warnings.push('No sites in the file.');
  return { ok: true, sites: store, warnings };
}

const sameMatchers = (a: SiteOverride['roles'][RoleName], b: SiteOverride['roles'][RoleName]) =>
  !!a && !!b && a.baseHash === b.baseHash && roleHash(a.matchers) === roleHash(b.matchers);

export interface SelectorsImportPlan {
  /** "bsky.app: postImage (new), postText, noAds on". */
  changes: string[];
  /** Roles and switches that already match. */
  unchanged: number;
  /** What won't be imported, and why. */
  skipped: string[];
  next: OverrideStore;
}

/** Merge `incoming` into `current`, per site and role (the file's win). Pure. */
export function planSelectorsImport(
  current: OverrideStore,
  incoming: OverrideStore,
  bundledSites: readonly SiteConfig[],
): SelectorsImportPlan {
  const byId = new Map(bundledSites.map((c) => [c.id, c]));
  const next: OverrideStore = { ...current };
  const changes: string[] = [];
  const skipped: string[] = [];
  let unchanged = 0;

  for (const siteId of Object.keys(incoming).sort()) {
    const site = incoming[siteId]!;
    const bundled = byId.get(siteId);
    const before = next[siteId];
    if (!bundled && !site.domains?.length && !before?.domains?.length) {
      skipped.push(`${siteId}: Wtv doesn’t know this site, and the file doesn’t say which domains it’s for.`);
      continue;
    }
    const entry: SiteOverride = { ...before, roles: { ...before?.roles } };
    if (before?.quirks) entry.quirks = { ...before.quirks };
    const notes: string[] = [];
    if (!bundled) {
      if (site.name !== undefined && site.name !== entry.name) entry.name = site.name;
      if (site.domains?.length && site.domains.join() !== entry.domains?.join()) {
        entry.domains = [...site.domains];
        notes.push(`domains ${site.domains.join(', ')}`);
      }
    }
    for (const [role, ov] of Object.entries(site.roles) as [RoleName, NonNullable<SiteOverride['roles'][RoleName]>][]) {
      if (!isOverrideCurrent(bundled, role, ov)) {
        skipped.push(`${siteId} ${role}: saved over other built-in selectors than this Wtv has, so it wouldn’t apply.`);
        continue;
      }
      const old = entry.roles[role];
      if (sameMatchers(old, ov)) {
        unchanged++;
        continue;
      }
      entry.roles[role] = ov;
      notes.push(old ? role : `${role} (new)`);
    }
    for (const q of USER_QUIRKS) {
      const value = site.quirks?.[q];
      if (value === undefined) continue;
      if (entry.quirks?.[q] === value) {
        unchanged++;
        continue;
      }
      entry.quirks = { ...entry.quirks, [q]: value };
      notes.push(`${q} ${value ? 'on' : 'off'}`);
    }
    if (notes.length === 0) continue;
    next[siteId] = entry;
    changes.push(`${siteId}: ${notes.join(', ')}`);
  }
  return { changes, unchanged, skipped, next };
}

export interface RepoWrite {
  /** `<siteId>.json` in src/sites/. */
  file: string;
  text: string;
  siteId: string;
  roles: RoleName[];
  quirks: UserQuirk[];
  /** No file for it yet: a new built-in site, which adds a host permission. */
  isNew: boolean;
}

export interface RepoPlan {
  writes: RepoWrite[];
  /** What won't be written, and why. */
  skipped: string[];
  /** The build would fail with these writes (then there are none). */
  errors: string[];
}

/**
 * Layer `incoming` over the repo's site files (`repo`: file name → text) and say what to
 * write. Pure.
 */
export function planRepoWrite(incoming: OverrideStore, repo: Readonly<Record<string, string>>): RepoPlan {
  const parsed: Record<string, unknown> = {};
  for (const [file, text] of Object.entries(repo)) {
    try {
      parsed[file] = JSON.parse(text);
    } catch {
      parsed[file] = null; // Fails validation, like the build would.
    }
  }
  const before = loadSiteConfigs(parsed);
  const byId = new Map(before.configs.map((c) => [c.id, c]));
  const after = { ...parsed };
  const writes: RepoWrite[] = [];
  const skipped: string[] = [];

  for (const siteId of Object.keys(incoming).sort()) {
    const site = incoming[siteId]!;
    const file = `${siteId}.json`;
    const base = byId.get(siteId);
    if (!base && file in repo) {
      skipped.push(`${siteId}: the repo’s ${file} doesn’t load; fix it first.`);
      continue;
    }
    const resolved = resolveSite(siteId, base, site);
    if (!resolved) {
      skipped.push(`${siteId}: not in the repo, and the file doesn’t say which domains it’s for.`);
      continue;
    }
    // Saved over other selectors than the repo has: written already, or the repo moved on.
    let already = 0;
    for (const s of resolved.stale) {
      if (roleHash(base?.roles[s.role]) === roleHash(site.roles[s.role]?.matchers)) already++;
      else skipped.push(`${siteId} ${s.role}: the repo’s selectors changed since this was saved; redo it on the page.`);
    }
    const roles = (Object.keys(resolved.sources) as RoleName[]).filter((r) => resolved.sources[r] === 'override');
    const quirks = USER_QUIRKS.filter((q) => site.quirks?.[q] !== undefined);
    if (roles.length === 0 && quirks.length === 0) {
      if (already > 0) skipped.push(`${siteId}: already in the repo.`);
      continue;
    }

    // A switch that's off is no switch in a site file.
    const config = resolved.config;
    if (config.quirks) {
      for (const q of USER_QUIRKS) if (config.quirks[q] === false) delete config.quirks[q];
      if (Object.keys(config.quirks).length === 0) delete config.quirks;
    }
    const text = siteConfigToJson(config);
    if (text === repo[file]) {
      skipped.push(`${siteId}: already in the repo.`);
      continue;
    }
    after[file] = JSON.parse(text);
    writes.push({ file, text, siteId, roles, quirks, isNew: !base });
  }

  const errors = loadSiteConfigs(after).errors.filter((e) => !before.errors.includes(e));
  return errors.length > 0 ? { writes: [], skipped, errors } : { writes, skipped, errors: [] };
}
