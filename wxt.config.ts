import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { isDevToolsMode } from './src/lib/build-mode';
import { loadSiteConfigs } from './src/lib/sites/load';
import { hostPermissionPatterns } from './src/lib/sites/match';

const SITES_DIR = fileURLToPath(new URL('./src/sites/', import.meta.url));

/** Validate bundled site configs at build time; any error fails the build. */
function bundledSitesForBuild() {
  const files: Record<string, unknown> = {};
  for (const file of readdirSync(SITES_DIR).filter((f) => f.endsWith('.json'))) {
    const path = join(SITES_DIR, file);
    try {
      files[path] = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`[wtv] ${file}: invalid JSON: ${(err as Error).message}`);
    }
  }
  const result = loadSiteConfigs(files);
  for (const w of result.warnings) console.warn(`[wtv] site config warning: ${w}`);
  if (result.errors.length > 0) {
    throw new Error(`[wtv] invalid site configs:\n  ${result.errors.join('\n  ')}`);
  }
  return result.configs;
}

export default defineConfig({
  srcDir: 'src',
  manifest: ({ mode }) => {
    const dev = isDevToolsMode(mode);
    return {
      name: dev ? 'Wtv (dev)' : 'Wtv',
      description: 'Web TV: the internet as a TV station. Mutes ads and shows something nicer instead.',
      // unlimitedStorage: the ad-picture library lives in IndexedDB. No install warning.
      permissions: ['storage', 'unlimitedStorage', 'scripting', 'activeTab'],
      // Bundled sites: always on. Content scripts are registered at runtime for these plus
      // any optional origin the user grants (see src/lib/injection.ts).
      host_permissions: hostPermissionPatterns(bundledSitesForBuild()),
      // Any other site is opt-in from the popup. No install-time warning.
      optional_host_permissions: ['*://*/*'],
      // The overlay page is framed into sites by the content script. Its own scripts,
      // styles and the cat pictures load from the extension origin, so only the page
      // itself must be web-accessible.
      web_accessible_resources: [{ resources: ['overlay.html'], matches: ['*://*/*'] }],
    };
  },
});
