/**
 * Built-in "this entry is gone" markers for sites without a bundled config.
 *
 * A bundled config puts its site in host_permissions (an install-time warning), so sites
 * Wtv only reaches through the user's own grant keep what's known about them here. They
 * are checked alongside the site's `unavailable` role (bundled or picked), never instead
 * of it, and with its default condition (`visible`).
 */
import { domainMatches } from './match';
import type { Matcher } from './schema';

const MARKERS: readonly { domains: readonly string[]; matchers: readonly Matcher[] }[] = [
  {
    // The banner a post page shows in place of the post when its author deleted it, or the
    // moderators / Reddit removed it ("Sorry, this post was deleted by the person who …").
    domains: ['reddit.com'],
    matchers: [{ selector: '[slot="post-removed-banner"]' }],
  },
];

/** The site's `unavailable` matchers, then the built-in ones for `host`. Pure. */
export function unavailableMatchers(host: string, siteMatchers: readonly Matcher[] | undefined): Matcher[] {
  const builtIn = MARKERS.filter((m) => m.domains.some((d) => domainMatches(host, d))).flatMap((m) => m.matchers);
  return [...(siteMatchers ?? []), ...builtIn];
}
