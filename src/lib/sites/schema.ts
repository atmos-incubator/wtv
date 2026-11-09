/**
 * Site config schema (data only — no code).
 *
 * Bundled configs live in `src/sites/<id>.json`, one per site. The file name stem must
 * equal `id`. User overrides are layered on top per role (see overrides.ts).
 */

export const SCHEMA_VERSION = 1;

export const ROLE_NAMES = [
  'video',
  'player',
  'adIndicator',
  'skip',
  'continuePrompt',
  'unavailable',
  'playButton',
  'progressBar',
  'title',
  'description',
  'keywords',
  'creator',
  // Posts (`view=card` read from the page itself: forums, social sites).
  'post',
  'postTitle',
  'postAuthor',
  'postText',
  'postTime',
  'postImage',
] as const;

/** The roles a post card is read from (see posts/page.ts). */
export const POST_ROLES = ['post', 'postTitle', 'postAuthor', 'postText', 'postTime', 'postImage'] as const;
export type PostRoleName = (typeof POST_ROLES)[number];

/** A site whose post can be read from the page: it has a selector for the text or the title. */
export function hasPostSelectors(roles: Roles): boolean {
  return (roles.postText?.length ?? 0) > 0 || (roles.postTitle?.length ?? 0) > 0;
}

export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * How a matched element is tested.
 *   - `exists`:  any element matches the selector.
 *   - `visible`: a matching element is rendered and visible (many sites keep ad nodes in
 *                the DOM and only hide them).
 * Class / attribute conditions are expressed in the selector itself
 * (e.g. `#movie_player.ad-showing`, `[aria-hidden="false"]`).
 */
export const CONDITIONS = ['exists', 'visible'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Default condition per role when a matcher doesn't specify `when`. */
export const ROLE_DEFAULT_WHEN: Record<RoleName, Condition> = {
  video: 'exists',
  // The box ads are drawn in. Present the whole time the page has a player.
  player: 'exists',
  adIndicator: 'visible',
  skip: 'visible',
  continuePrompt: 'visible',
  // The player's "Video unavailable" error. Sites keep error nodes around, hidden.
  unavailable: 'visible',
  playButton: 'visible',
  // Players fade their controls out; the bar's geometry is still what a seek maps onto.
  progressBar: 'exists',
  title: 'exists',
  description: 'exists',
  keywords: 'exists',
  creator: 'exists',
  post: 'exists',
  postTitle: 'exists',
  postAuthor: 'exists',
  postText: 'exists',
  postTime: 'exists',
  postImage: 'exists',
};

/**
 * Selector syntax: plain CSS, with ` >>> ` stepping into an element's shadow root.
 *   "ytd-app >>> #movie_player video"
 * means: find `ytd-app`, then query `#movie_player video` inside its shadowRoot.
 */
export const SHADOW_PIERCE = '>>>';

export interface Matcher {
  selector: string;
  when?: Condition;
}

/** Each role is an ordered list of fallback matchers. First match wins. */
export type Roles = Partial<Record<RoleName, Matcher[]>>;

export interface SiteQuirks {
  /** Pixels at the bottom of the video left uncovered by the click shield (site controls). */
  controlBarInset?: number;
  /**
   * Ads play in the main <video> element itself (YouTube), rather than a separate
   * element or iframe. Enables skipping a skippable ad by seeking it to its end when the
   * site ignores synthetic clicks on its Skip button.
   */
  adsInMainVideo?: boolean;
}

export interface SiteConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Primary domain, e.g. "youtube.com". Equals the bundled file name stem. */
  id: string;
  /** Human-readable name, e.g. "YouTube". */
  name: string;
  /** Hostnames this config applies to. Each matches itself and all subdomains. */
  domains: string[];
  roles: Roles;
  quirks?: SiteQuirks;
  /**
   * Hosts the site's thumbnails come from (`i.ytimg.com`). Wtv asks for access to them
   * at Play, to cache entry thumbnails; they never get content scripts.
   */
  thumbnailHosts?: string[];
}

export function effectiveWhen(role: RoleName, matcher: Matcher): Condition {
  return matcher.when ?? ROLE_DEFAULT_WHEN[role];
}

export function selectorSegments(selector: string): string[] {
  return selector.split(SHADOW_PIERCE).map((s) => s.trim());
}
