import { findSite } from './match';
import { resolveSite, type OverrideStore, type ResolvedSite } from './overrides';
import type { SiteConfig } from './schema';

/**
 * Find and resolve the site config for a hostname, considering bundled sites and
 * user-defined sites (overrides with their own domains and no bundled config).
 */
export function resolveForHost(
  host: string,
  bundledSites: readonly SiteConfig[],
  overrides: OverrideStore,
): ResolvedSite | undefined {
  const byId = new Map(bundledSites.map((c) => [c.id, c]));

  const candidates: { id: string; domains: string[] }[] = bundledSites.map((c) => ({
    id: c.id,
    domains: c.domains,
  }));
  for (const [id, ov] of Object.entries(overrides)) {
    if (!byId.has(id) && ov.domains?.length) candidates.push({ id, domains: ov.domains });
  }

  const match = findSite(host, candidates);
  if (!match) return undefined;
  return resolveSite(match.id, byId.get(match.id), overrides[match.id]);
}

/**
 * How a page is handled:
 *   - bundled: a shipped site config (plus any user overrides).
 *   - user:    a site the user defined with the picker.
 *   - generic: no config; heuristics only.
 */
export type SiteProfile =
  | { kind: 'bundled' | 'user'; site: ResolvedSite }
  | { kind: 'generic'; site: null };

export function profileForHost(
  host: string,
  bundledSites: readonly SiteConfig[],
  overrides: OverrideStore,
): SiteProfile {
  const site = resolveForHost(host, bundledSites, overrides);
  if (!site) return { kind: 'generic', site: null };
  return { kind: site.userDefined ? 'user' : 'bundled', site };
}
