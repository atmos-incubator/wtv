/**
 * Content-script registration. Scripts are registered at runtime for exactly the origins
 * Wtv holds host permission for: bundled sites (required host_permissions) plus any site
 * the user enabled (optional_host_permissions). Re-run whenever permissions change.
 *
 * Thumbnail hosts (`thumbnailHosts` in site configs, e.g. i.ytimg.com) and post API
 * hosts (`apiHosts` in posts/adapters.ts, e.g. publish.x.com) are granted only so the
 * background can fetch from them: they never get content scripts. (A post site that is
 * also a site people watch, like www.reddit.com, keeps them.)
 */
import { browser } from 'wxt/browser';
import { allThumbnailOrigins } from './media-library/record';
import { originPatternForHost, webMatchPatterns } from './permissions';
import { ALL_POST_API_HOSTS } from './posts/adapters';
import { BUNDLED_SITES } from './sites/bundled';

/** The http(s) patterns that get content scripts. */
export function contentScriptPatterns(origins: readonly string[]): string[] {
  const fetchOnly = allThumbnailOrigins(BUNDLED_SITES);
  for (const host of ALL_POST_API_HOSTS) fetchOnly.add(originPatternForHost(host));
  return webMatchPatterns(origins).filter((o) => !fetchOnly.has(o));
}

/** Must match WXT's generated PublicPath type (.wxt/types/paths.d.ts, refreshed by `wxt prepare`). */
export const SCRIPT_FILES = {
  hook: '/content-scripts/media-hook.js',
  agent: '/content-scripts/media.js',
} as const;

export const SCRIPT_IDS = {
  hook: 'wtv-media-hook',
  agent: 'wtv-media',
} as const;

/** Returns the match patterns now registered. */
export async function syncContentScripts(): Promise<string[]> {
  const { origins = [] } = await browser.permissions.getAll();
  const matches = contentScriptPatterns(origins);

  const ids: string[] = Object.values(SCRIPT_IDS);
  const existing = await browser.scripting.getRegisteredContentScripts({ ids });
  if (existing.length > 0) {
    await browser.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  }
  if (matches.length === 0) return matches;

  await browser.scripting.registerContentScripts([
    {
      id: SCRIPT_IDS.hook,
      js: [SCRIPT_FILES.hook],
      matches,
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      persistAcrossSessions: true,
    },
    {
      id: SCRIPT_IDS.agent,
      js: [SCRIPT_FILES.agent],
      matches,
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ]);
  return matches;
}

/**
 * Inject into an already-open tab (registration only affects future page loads).
 * The hook goes in first so it can catch play() calls the agent's scan would miss.
 * `allFrames: false` for activeTab use, which only grants the top frame.
 */
export async function injectIntoTab(tabId: number, allFrames: boolean): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId, allFrames },
    files: [SCRIPT_FILES.hook],
    world: 'MAIN',
    injectImmediately: true,
  });
  await browser.scripting.executeScript({
    target: { tabId, allFrames },
    files: [SCRIPT_FILES.agent],
  });
}

/** Inject into every open tab matching the given patterns (after a permission grant). */
export async function injectIntoMatchingTabs(patterns: readonly string[]): Promise<void> {
  const web = contentScriptPatterns(patterns);
  if (web.length === 0) return;
  const tabs = await browser.tabs.query({ url: web });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await injectIntoTab(tab.id, true);
      } catch (err) {
        console.warn(`[wtv] could not inject into tab ${tab.id}:`, err);
      }
    }),
  );
}
