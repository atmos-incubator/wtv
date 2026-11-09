import { describe, expect, it } from 'vitest';
import { unavailableMatchers } from './gone-markers';

describe('unavailableMatchers', () => {
  it('adds the built-in markers for the host after the site’s own', () => {
    const own = [{ selector: '.gone' }];
    expect(unavailableMatchers('www.reddit.com', own)).toEqual([own[0], { selector: '[slot="post-removed-banner"]' }]);
    expect(unavailableMatchers('old.reddit.com', undefined)).toHaveLength(1);
  });

  it('leaves other sites as they are', () => {
    expect(unavailableMatchers('notreddit.com', undefined)).toEqual([]);
    expect(unavailableMatchers('www.youtube.com', [{ selector: '.x' }])).toEqual([{ selector: '.x' }]);
  });
});
