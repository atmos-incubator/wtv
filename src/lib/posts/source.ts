/**
 * Where a `view=card` entry's post comes from. Pure.
 *
 *   - `page`: the post's own page, opened in the playlist's tab (signed in, as the user
 *     is) and read with the site's post selectors (posts/page.ts). Any site, once its
 *     post roles are picked in the side panel (Fix selectors → Posts). Wins when the
 *     site has them: picking them is how the user says "use my sign-in".
 *   - `api`: the site's public endpoint, anonymously, through its adapter (adapters.ts:
 *     X, Reddit, Bluesky). Also the fallback when reading the page fails.
 *   - null: neither.
 */
import { resolveForHost } from '../sites/registry';
import type { OverrideStore } from '../sites/overrides';
import { hasPostSelectors, type SiteConfig } from '../sites/schema';
import { findPostAdapter } from './adapters';

export type CardSource = 'page' | 'api';

/** The site has post selectors (built in or the user's). */
export function siteReadsPosts(url: string, bundled: readonly SiteConfig[], overrides: OverrideStore): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  const site = resolveForHost(host, bundled, overrides);
  return site ? hasPostSelectors(site.config.roles) : false;
}

export function cardSource(url: string, bundled: readonly SiteConfig[], overrides: OverrideStore): CardSource | null {
  if (siteReadsPosts(url, bundled, overrides)) return 'page';
  return findPostAdapter(url) ? 'api' : null;
}
