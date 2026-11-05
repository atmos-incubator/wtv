import type { SiteConfig } from './schema';
import { validateSiteConfig } from './validate';

export interface LoadResult {
  configs: SiteConfig[];
  errors: string[];
  warnings: string[];
}

function fileStem(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.json$/i, '');
}

/**
 * Validate a set of raw bundled configs keyed by file path. Shared by the runtime
 * loader (Vite glob) and wxt.config.ts (node fs), so a bad config fails the build.
 */
export function loadSiteConfigs(files: Record<string, unknown>): LoadResult {
  const configs: SiteConfig[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const domainOwner = new Map<string, string>();

  for (const [path, raw] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const stem = fileStem(path);
    const result = validateSiteConfig(raw, stem);
    warnings.push(...result.warnings.map((w) => `${stem}: ${w}`));
    if (!result.ok) {
      errors.push(...result.errors.map((e) => `${stem}: ${e}`));
      continue;
    }
    let clash = false;
    for (const d of result.value.domains) {
      const owner = domainOwner.get(d);
      if (owner) {
        errors.push(`${stem}: domain "${d}" is already claimed by ${owner}`);
        clash = true;
      } else {
        domainOwner.set(d, stem);
      }
    }
    if (!clash) configs.push(result.value);
  }

  return { configs, errors, warnings };
}
