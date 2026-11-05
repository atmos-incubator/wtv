export interface HasDomains {
  domains: string[];
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** `youtube.com` matches `youtube.com` and `*.youtube.com`, but not `notyoutube.com`. */
export function domainMatches(host: string, domain: string): boolean {
  const h = normalizeHost(host);
  return h === domain || h.endsWith(`.${domain}`);
}

/**
 * Pick the site whose matching domain is the most specific (longest).
 * Ties go to the earlier entry in `sites`.
 */
export function findSite<T extends HasDomains>(host: string, sites: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestLength = -1;
  for (const site of sites) {
    for (const domain of site.domains) {
      if (domain.length > bestLength && domainMatches(host, domain)) {
        best = site;
        bestLength = domain.length;
      }
    }
  }
  return best;
}

/** Manifest match patterns. `*.example.com` also matches `example.com` itself. */
export function hostPermissionPatterns(sites: readonly HasDomains[]): string[] {
  const patterns = new Set<string>();
  for (const site of sites) for (const d of site.domains) patterns.add(`*://*.${d}/*`);
  return [...patterns].sort();
}
