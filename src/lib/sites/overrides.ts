/**
 * User overrides, layered over bundled configs per role.
 *
 * Also the user's per-site switches (`quirks`: no ads, starts by itself; USER_QUIRKS).
 * Those are plain settings, not selectors: they always apply, whatever a release changes.
 *
 * Each role override records `baseHash`: the hash of the bundled role it replaced
 * (or NO_BASE if the bundled config had no such role / no such site). An override
 * applies only while the bundled role still hashes to `baseHash`. Once a release
 * changes that role, the bundled version wins and the override is reported stale.
 *
 * This means nobody has to remember to bump a version number when fixing selectors.
 */
import { canonicalJson, cyrb53 } from '../hash';
import { SCHEMA_VERSION, USER_QUIRKS, type Matcher, type RoleName, type SiteConfig, type UserQuirk } from './schema';
import { isHostname, isRecord, isRoleName, validateMatchers } from './validate';

export const NO_BASE = 'none';

export interface RoleOverride {
  /** Empty: every built-in selector of the role was removed, so the role is off. */
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
  /** The user's switches; each wins over the bundled config's (false turns one off). */
  quirks?: Partial<Record<UserQuirk, boolean>>;
}

/** The site entry has nothing in it any more. */
const isEmpty = (site: SiteOverride) => Object.keys(site.roles).length === 0 && Object.keys(site.quirks ?? {}).length === 0;

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
      if (ov.matchers.length > 0) config.roles[role] = structuredClone(ov.matchers);
      else delete config.roles[role];
      sources[role] = 'override';
    } else {
      stale.push({ siteId, role, savedAt: ov.savedAt });
    }
  }
  if (override?.quirks && Object.keys(override.quirks).length > 0) {
    config.quirks = { ...config.quirks, ...override.quirks };
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
    const kept = { ...site, roles };
    if (!isEmpty(kept)) next[siteId] = kept;
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

/**
 * Remove selectors from a role's effective list (bundled or override). Pure.
 *   - What's left equals the bundled list: the override is dropped (same as Reset).
 *   - Nothing left of a bundled role: an empty override, which turns the role off until
 *     Reset or a release that changes it.
 *   - Nothing left of a role the bundled config lacks: the override is dropped.
 */
export function withSelectorsRemoved(
  store: OverrideStore,
  bundled: SiteConfig | undefined,
  siteId: string,
  role: RoleName,
  selectors: readonly string[],
  now: number = Date.now(),
): OverrideStore {
  const current = resolveSite(siteId, bundled, store[siteId])?.config.roles[role] ?? [];
  const drop = new Set(selectors);
  const left = current.filter((m) => !drop.has(m.selector));
  if (left.length === current.length) return store;
  if (roleHash(left) === roleHash(bundled?.roles[role])) return withoutRoleOverride(store, siteId, role);
  return withRoleOverride(store, bundled, siteId, role, left, {}, now);
}

/** Remove one role override (revert to bundled). Pure. */
export function withoutRoleOverride(store: OverrideStore, siteId: string, role: RoleName): OverrideStore {
  const existing = store[siteId];
  if (!existing?.roles[role]) return store;
  const roles = { ...existing.roles };
  delete roles[role];
  const next = { ...store };
  const site = { ...existing, roles };
  if (!isEmpty(site)) next[siteId] = site;
  else delete next[siteId];
  return next;
}

/**
 * Set one of the user's switches (USER_QUIRKS). Pure. Matching the bundled config's
 * value (unset counts as false) drops it, so only real differences are stored. A site
 * with no bundled config becomes a user-defined one (`site` names it).
 */
export function withQuirk(
  store: OverrideStore,
  bundled: SiteConfig | undefined,
  siteId: string,
  key: UserQuirk,
  value: boolean,
  site: { name?: string; domains?: string[] } = {},
): OverrideStore {
  const existing: SiteOverride = store[siteId] ?? { roles: {} };
  const quirks = { ...existing.quirks };
  if (value === Boolean(bundled?.quirks?.[key])) delete quirks[key];
  else quirks[key] = value;
  const entry: SiteOverride = { ...existing, quirks };
  if (Object.keys(quirks).length === 0) delete entry.quirks;
  if (!bundled) {
    if (entry.name === undefined && site.name !== undefined) entry.name = site.name;
    if (entry.domains === undefined && site.domains !== undefined) entry.domains = [...site.domains];
  }
  const next = { ...store };
  if (isEmpty(entry)) delete next[siteId];
  else next[siteId] = entry;
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
      // Empty is valid only as "removed every built-in selector" (it has a base).
      if (errors.length > 0 || (matchers.length === 0 && ov.baseHash === NO_BASE)) {
        warnings.push(...errors, `${path}: invalid selectors, override dropped`);
        continue;
      }
      site.roles[role] = { matchers, baseHash: ov.baseHash, savedAt: ov.savedAt };
    }
    if (entry.quirks !== undefined) {
      if (isRecord(entry.quirks)) {
        const quirks: SiteOverride['quirks'] = {};
        for (const [key, value] of Object.entries(entry.quirks)) {
          if ((USER_QUIRKS as readonly string[]).includes(key) && typeof value === 'boolean') quirks[key as UserQuirk] = value;
          else warnings.push(`overrides.${siteId}.quirks.${key}: dropped`);
        }
        if (Object.keys(quirks).length > 0) site.quirks = quirks;
      } else {
        warnings.push(`overrides.${siteId}.quirks: invalid, dropped`);
      }
    }
    if (!isEmpty(site)) store[siteId] = site;
  }
  return { store, warnings };
}
