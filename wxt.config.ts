import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { isDevToolsMode } from './src/lib/build-mode';
import { checkSvg, loadBuiltinPlaylists } from './src/lib/playlist/builtin';
import { loadSiteConfigs } from './src/lib/sites/load';
import { hostPermissionPatterns } from './src/lib/sites/match';

const SITES_DIR = fileURLToPath(new URL('./src/sites/', import.meta.url));
const PLAYLISTS_DIR = fileURLToPath(new URL('./src/playlists/', import.meta.url));
/** Apache-2.0: Readability's license ships with the code that includes it (the overlay page). */
const READABILITY_LICENSE = fileURLToPath(new URL('./node_modules/@mozilla/readability/LICENSE.md', import.meta.url));

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

/** Validate the built-in playlists and their cover SVGs at build time; any error fails the build. */
function checkBuiltinPlaylists(): void {
  const texts: Record<string, string> = {};
  const covers: Record<string, string> = {};
  const errors: string[] = [];
  for (const file of readdirSync(PLAYLISTS_DIR)) {
    const path = join(PLAYLISTS_DIR, file);
    if (file.endsWith('.txt')) texts[path] = readFileSync(path, 'utf8');
    else if (file.endsWith('.svg')) {
      const bytes = readFileSync(path);
      covers[path] = bytes.toString('utf8');
      errors.push(...checkSvg(covers[path], bytes.length).map((e) => `playlists/${file}: ${e}`));
    }
  }
  const result = loadBuiltinPlaylists(texts, covers);
  for (const n of result.notes) console.info(`[wtv] built-in playlist: ${n}`);
  errors.push(...result.errors);
  if (errors.length > 0) throw new Error(`[wtv] invalid built-in playlists:\n  ${errors.join('\n  ')}`);
}

export default defineConfig({
  srcDir: 'src',
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      files.push({ absoluteSrc: READABILITY_LICENSE, relativeDest: 'licenses/readability-LICENSE.md' });
    },
  },
  manifest: ({ mode }) => {
    const dev = isDevToolsMode(mode);
    checkBuiltinPlaylists();
    return {
      name: dev ? 'Wtv (dev)' : 'Wtv',
      description: 'Web TV: the internet as a TV station. Mutes ads and shows something nicer instead.',
      // unlimitedStorage: the ad-picture library lives in IndexedDB. No install warning.
      // contextMenus: "Add to Wtv playlist". No install warning.
      permissions: ['storage', 'unlimitedStorage', 'scripting', 'activeTab', 'contextMenus'],
      // Bundled sites: always on. Content scripts are registered at runtime for these plus
      // any optional origin the user grants (see src/lib/injection.ts).
      host_permissions: hostPermissionPatterns(bundledSitesForBuild()),
      // Any other site is opt-in from the popup. No install-time warning.
      optional_host_permissions: ['*://*/*'],
      // The overlay page is framed into sites by the content script. Its own scripts,
      // styles and the cat pictures load from the extension origin, so only the page
      // itself must be web-accessible.
      // card.html: framed over a post's page beside its embedded player (posts/embed.ts).
      web_accessible_resources: [{ resources: ['overlay.html', 'card.html'], matches: ['*://*/*'] }],
      // Chrome allows at most four suggested shortcuts; the rest can be bound at
      // chrome://extensions/shortcuts. Keep names in sync with COMMANDS in
      // src/lib/view/controller.ts and PLAYLIST_COMMANDS in src/lib/playlist/runner.ts.
      commands: {
        'play-pause': {
          suggested_key: { default: 'Alt+Shift+P' },
          description: 'Play / pause the video',
        },
        maximize: {
          suggested_key: { default: 'Alt+Shift+M' },
          description: 'Maximize / restore the video',
        },
        'tv-mode': {
          suggested_key: { default: 'Alt+Shift+F' },
          description: 'TV mode: maximized video in a fullscreen window',
        },
        mute: {
          description: 'Mute / unmute the tab',
        },
        next: {
          suggested_key: { default: 'Alt+Shift+N' },
          description: 'Playlist: next entry',
        },
        previous: {
          description: 'Playlist: previous entry',
        },
      },
    };
  },
});
