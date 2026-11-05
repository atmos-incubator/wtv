import { loadSiteConfigs } from './load';
import { hostPermissionPatterns } from './match';
import type { SiteConfig } from './schema';

const files = import.meta.glob<unknown>('../../sites/*.json', { eager: true, import: 'default' });

const result = loadSiteConfigs(files);

for (const e of result.errors) console.error('[wtv] bundled site config:', e);
for (const w of result.warnings) console.warn('[wtv] bundled site config:', w);

/** Validated bundled site configs (invalid ones are excluded and logged). */
export const BUNDLED_SITES: readonly SiteConfig[] = result.configs;

/** Match patterns for the bundled sites (same as the manifest's host_permissions). */
export const BUNDLED_MATCHES: string[] = hostPermissionPatterns(BUNDLED_SITES);

/** Exposed for tests: the full load result including errors. */
export const BUNDLED_LOAD_RESULT = result;
