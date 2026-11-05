/**
 * User overrides, layered over bundled configs per role.
 *
 * Each role override records `baseHash`: the hash of the bundled role it replaced
 * (or NO_BASE if the bundled config had no such role / no such site). An override
 * applies only while the bundled role still hashes to `baseHash`. Once a release
 * changes that role, the bundled version wins and the override is reported stale.
 *
 * This means nobody has to remember to bump a version number when fixing selectors.
 */
import { canonicalJson, cyrb53 } from '../hash';
import { SCHEMA_VERSION, type Matcher, type RoleName, type SiteConfig } from './schema';
import { isHostname, isRecord, isRoleName, validateMatchers } from './validate';

export const NO_BASE = 'none';

export interface RoleOverride {
  matchers: Matcher[];
  baseHash: string;
  savedAt: number;
}

export interface SiteOverride {
  /** Only used for user-defined sites (no bundled config). */
  name?: string;
  /** Only used for user-defined sites (no bundled config). */
  domains?: string[];
  roles: Partial<Record<RoleName, RoleOverride>>;
}

/** Keyed by site id. */
export type OverrideStore = Record<string, SiteOverride>;

export type RoleSource = 'bundled' | 'override';

export interface StaleOverride {
  siteId: string;
  role: RoleName;
  savedAt: number;
}

export interface ResolvedSite {
  config: SiteConfig;
  sources: Partial<Record<RoleName, RoleSource>>;
  /** Overrides ignored because the bundled role changed since they were saved. */
  stale: StaleOverride[];
  userDefined: boolean;
}

export function roleHash(matchers: readonly Matcher[] | undefined): string {
  if (!matchers || matchers.length === 0) return NO_BASE;
  return cyrb53(canonicalJson(matchers.map((m) => ({ selector: m.selector, when: m.when }))));
}

export function makeRoleOverride(
  bundled: SiteConfig | undefined,
  role: RoleName,
  matchers: Matcher[],
  now: number = Date.now(),
): RoleOverride {
  return { matchers, baseHash: roleHash(bundled?.roles[role]), savedAt: now };
}

export function isOverrideCurrent(
  bundled: SiteConfig | undefined,
  role: RoleName,
  override: RoleOverride,
): boolean {
  return override.baseHash === roleHash(bundled?.roles[role]);
}

/**
 * Merge bundled config + override for one site.
 * Returns undefined when there's nothing usable (no bundled config and the override
 * isn't a complete user-defined site).
 */
export function resolveSite(
  siteId: string,
  bundled: SiteConfig | undefined,
  override: SiteOverride | undefined,
): ResolvedSite | undefined {
  const userDefined = bundled === undefined;
  if (userDefined && !override?.domains?.length) return undefined;

  const config: SiteConfig = bundled
    ? structuredClone(bundled)
    : {
        schemaVersion: SCHEMA_VERSION,
        id: siteId,
        name: override?.name ?? siteId,
        domains: [...(override?.domains ?? [])],
        roles: {},
      };

  const sources: Partial<Record<RoleName, RoleSource>> = {};
  for (const role of Object.keys(config.roles) as RoleName[]) sources[role] = 'bundled';

  const stale: StaleOverride[] = [];
  for (const [role, ov] of Object.entries(override?.roles ?? {}) as [RoleName, RoleOverride][]) {
    if (isOverrideCurrent(bundled, role, ov)) {
      config.roles[role] = structuredClone(ov.matchers);
      sources[role] = 'override';
    } else {
      stale.push({ siteId, role, savedAt: ov.savedAt });
    }
  }

  return { config, sources, stale, userDefined };
}

/** Drop stale role overrides, and sites left with no roles. Pure. */
export function pruneStaleOverrides(
  store: OverrideStore,
  bundledSites: readonly SiteConfig[],
): { store: OverrideStore; removed: StaleOverride[] } {
  const byId = new Map(bundledSites.map((c) => [c.id, c]));
  const next: OverrideStore = {};
  const removed: StaleOverride[] = [];

  for (const [siteId, site] of Object.entries(store)) {
    const bundled = byId.get(siteId);
    const roles: SiteOverride['roles'] = {};
    for (const [role, ov] of Object.entries(site.roles) as [RoleName, RoleOverride][]) {
      if (isOverrideCurrent(bundled, role, ov)) roles[role] = ov;
      else removed.push({ siteId, role, savedAt: ov.savedAt });
    }
    if (Object.keys(roles).length > 0) next[siteId] = { ...site, roles };
  }

  return { store: next, removed };
}

/** Set (or replace) one role override. Pure. */
export function withRoleOverride(
  store: OverrideStore,
  bundled: SiteConfig | undefined,
  siteId: string,
  role: RoleName,
  matchers: Matcher[],
  site: { name?: string; domains?: string[] } = {},
  now: number = Date.now(),
): OverrideStore {
  const existing = store[siteId];
  const entry: SiteOverride = {
    ...existing,
    roles: { ...existing?.roles, [role]: makeRoleOverride(bundled, role, matchers, now) },
  };
  if (!bundled) {
    if (site.name !== undefined) entry.name = site.name;
    if (site.domains !== undefined) entry.domains = [...site.domains];
  }
  return { ...store, [siteId]: entry };
}

/** Remove one role override (revert to bundled). Pure. */
export function withoutRoleOverride(store: OverrideStore, siteId: string, role: RoleName): OverrideStore {
  const existing = store[siteId];
  if (!existing?.roles[role]) return store;
  const roles = { ...existing.roles };
  delete roles[role];
  const next = { ...store };
  if (Object.keys(roles).length > 0) next[siteId] = { ...existing, roles };
  else delete next[siteId];
  return next;
}

/**
 * Sanitize whatever is in storage. Invalid entries are dropped with warnings rather than
 * failing, so one corrupt override can't break every site.
 */
export function validateOverrideStore(raw: unknown): { store: OverrideStore; warnings: string[] } {
  const warnings: string[] = [];
  const store: OverrideStore = {};
  if (raw === undefined || raw === null) return { store, warnings };
  if (!isRecord(raw)) return { store, warnings: ['override store is not an object; ignored'] };

  for (const [siteId, entry] of Object.entries(raw)) {
    if (!isHostname(siteId)) {
      warnings.push(`overrides: invalid site id "${siteId}" dropped`);
      continue;
    }
    if (!isRecord(entry) || !isRecord(entry.roles)) {
      warnings.push(`overrides.${siteId}: malformed entry dropped`);
      continue;
    }
    const site: SiteOverride = { roles: {} };
    if (typeof entry.name === 'string' && entry.name.trim()) site.name = entry.name.trim();
    if (entry.domains !== undefined) {
      if (Array.isArray(entry.domains) && entry.domains.every(isHostname)) site.domains = [...entry.domains];
      else warnings.push(`overrides.${siteId}.domains: invalid, dropped`);
    }
    for (const [role, ov] of Object.entries(entry.roles)) {
      const path = `overrides.${siteId}.roles.${role}`;
      if (!isRoleName(role)) {
        warnings.push(`${path}: unknown role dropped`);
        continue;
      }
      if (!isRecord(ov) || typeof ov.baseHash !== 'string' || typeof ov.savedAt !== 'number') {
        warnings.push(`${path}: malformed override dropped`);
        continue;
      }
      const errors: string[] = [];
      const matchers = validateMatchers(ov.matchers, `${path}.matchers`, errors, warnings);
      if (errors.length > 0 || matchers.length === 0) {
        warnings.push(...errors, `${path}: invalid selectors, override dropped`);
        continue;
      }
      site.roles[role] = { matchers, baseHash: ov.baseHash, savedAt: ov.savedAt };
    }
    if (Object.keys(site.roles).length > 0) store[siteId] = site;
  }
  return { store, warnings };
}
