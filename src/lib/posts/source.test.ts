import { describe, expect, it } from 'vitest';
import { makeRoleOverride, type OverrideStore } from '../sites/overrides';
import { hasPostSelectors, type SiteConfig } from '../sites/schema';
import { cardSource, siteReadsPosts } from './source';

const BUNDLED: SiteConfig[] = [
  { schemaVersion: 1, id: 'youtube.com', name: 'YouTube', domains: ['youtube.com'], roles: { video: [{ selector: 'video' }] } },
];

function userSite(id: string, roles: Record<string, string>): OverrideStore {
  return {
    [id]: {
      name: id,
      domains: [id],
      roles: Object.fromEntries(
        Object.entries(roles).map(([role, selector]) => [role, makeRoleOverride(undefined, role as never, [{ selector }], 1)]),
      ),
    },
  };
}

describe('where a card comes from', () => {
  it('reads the page when the site has post selectors, signed in', () => {
    const overrides = { ...userSite('forum.example', { postText: '.post .body' }), ...userSite('reddit.com', { postTitle: 'h1' }) };
    expect(cardSource('https://forum.example/t/1', BUNDLED, overrides)).toBe('page');
    expect(cardSource('https://www.reddit.com/r/a/comments/abc/', BUNDLED, overrides)).toBe('page');
    expect(siteReadsPosts('https://www.reddit.com/r/a/comments/abc/', BUNDLED, overrides)).toBe(true);
  });

  it('uses the post adapter otherwise, and nothing for sites with neither', () => {
    const overrides = userSite('forum.example', { postAuthor: '.author' });
    expect(cardSource('https://forum.example/t/1', BUNDLED, overrides)).toBeNull();
    expect(cardSource('https://bsky.app/profile/a.b/post/x', BUNDLED, overrides)).toBe('api');
    expect(cardSource('https://www.youtube.com/watch?v=a', BUNDLED, {})).toBeNull();
    expect(cardSource('not a url', BUNDLED, {})).toBeNull();
  });

  it('needs the text or the title', () => {
    expect(hasPostSelectors({ postText: [{ selector: 'p' }] })).toBe(true);
    expect(hasPostSelectors({ postTitle: [{ selector: 'h1' }] })).toBe(true);
    expect(hasPostSelectors({ postAuthor: [{ selector: 'a' }], postText: [] })).toBe(false);
  });
});
