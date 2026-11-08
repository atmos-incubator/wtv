import { describe, expect, it } from 'vitest';
import {
  ALL_POST_FETCH_HOSTS,
  CARD_MAX_S,
  CARD_MIN_S,
  X_ADAPTER,
  cardDurationS,
  decodeEntities,
  findPostAdapter,
  parsePost,
  parseXOembed,
  postFetchHosts,
  postTitle,
} from './adapters';

/** publish.x.com's answer for a real post (November 2026). */
const OEMBED = {
  url: 'https://x.com/Interior/status/463440424141459456',
  author_name: 'U.S. Department of the Interior',
  author_url: 'https://x.com/Interior',
  html:
    '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">Sunsets don&#39;t get much better than this one over ' +
    '<a href="https://x.com/GrandTetonNPS?ref_src=twsrc%5Etfw">@GrandTetonNPS</a>. <a href="https://x.com/hashtag/nature?src=hash&amp;ref_src=twsrc%5Etfw">#nature</a> ' +
    '<a href="https://x.com/hashtag/sunset?src=hash&amp;ref_src=twsrc%5Etfw">#sunset</a> <a href="http://t.co/YuKy2rcjyU">pic.twitter.com/YuKy2rcjyU</a></p>' +
    '&mdash; U.S. Department of the Interior (@Interior) <a href="https://x.com/Interior/status/463440424141459456?ref_src=twsrc%5Etfw">May 5, 2014</a></blockquote>\n\n',
  width: 550,
  type: 'rich',
  provider_name: 'X',
};

describe('finding the adapter', () => {
  it('knows X posts by any spelling', () => {
    for (const url of [
      'https://x.com/Interior/status/463440424141459456',
      'https://twitter.com/Interior/status/463440424141459456?s=20',
      'https://mobile.twitter.com/Interior/status/463440424141459456/photo/1',
      'http://www.x.com/Interior/statuses/463440424141459456',
    ]) {
      expect(findPostAdapter(url)?.canonical).toBe('https://x.com/Interior/status/463440424141459456');
    }
    expect(findPostAdapter('https://x.com/i/web/status/123')?.canonical).toBe('https://x.com/i/web/status/123');
  });

  it('turns down everything else', () => {
    expect(findPostAdapter('https://x.com/Interior')).toBeNull();
    expect(findPostAdapter('https://x.com.evil.example/a/status/1')).toBeNull();
    expect(findPostAdapter('https://bsky.app/profile/a/post/1')).toBeNull();
    expect(findPostAdapter('nope')).toBeNull();
  });

  it('fetches from oEmbed', () => {
    expect(X_ADAPTER.endpoint('https://x.com/a/status/1')).toBe(
      'https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1&omit_script=1&dnt=true',
    );
    expect(postFetchHosts(['https://x.com/a/status/1', 'https://twitter.com/b/status/2', 'https://a.com/'])).toEqual(['publish.x.com']);
    expect(ALL_POST_FETCH_HOSTS).toContain('publish.x.com');
  });
});

describe('X oEmbed', () => {
  it('reads the text, author, handle and date, without the picture link', () => {
    expect(parseXOembed(OEMBED, 'https://x.com/Interior/status/463440424141459456')).toEqual({
      site: 'X',
      author: 'U.S. Department of the Interior',
      handle: '@Interior',
      text: 'Sunsets don\'t get much better than this one over @GrandTetonNPS. #nature #sunset',
      time: 'May 5, 2014',
      url: 'https://x.com/Interior/status/463440424141459456',
      images: [],
    });
  });

  it('keeps line breaks, and never lets markup through', () => {
    const post = parseXOembed(
      { ...OEMBED, html: '<blockquote><p>one<br>two &lt;b&gt;<script>x</script></p></blockquote>' },
      'https://x.com/a/status/1',
    );
    expect(post?.text).toBe('one\ntwo <b>x');
    expect(post?.time).toBeNull();
  });

  it('gives up on answers it doesn\'t understand', () => {
    expect(parseXOembed(null, 'u')).toBeNull();
    expect(parseXOembed({ html: '<div>no paragraph</div>' }, 'u')).toBeNull();
  });

  it('decodes entities', () => {
    expect(decodeEntities('&amp;&lt;&#39;&#x1F600;&mdash;&bogus;')).toBe('&<\'😀—&bogus;');
  });
});

describe('cards', () => {
  it('stays up longer for longer posts, within limits', () => {
    expect(cardDurationS('hi')).toBe(CARD_MIN_S);
    expect(cardDurationS('word '.repeat(30))).toBe(18);
    expect(cardDurationS('word '.repeat(500))).toBe(CARD_MAX_S);
  });

  it('titles a post for the library', () => {
    const post = parseXOembed(OEMBED, 'https://x.com/Interior/status/463440424141459456')!;
    expect(postTitle(post)).toBe(`U.S. Department of the Interior: ${post.text}`);
    expect(postTitle({ ...post, text: 'x'.repeat(200) })).toMatch(/^U\.S\. Department of the Interior: x{79}…$/);
    expect(postTitle({ ...post, text: '' })).toBe('U.S. Department of the Interior');
  });

  it('checks posts passed between pages', () => {
    const post = parseXOembed(OEMBED, 'https://x.com/Interior/status/463440424141459456')!;
    expect(parsePost(post)).toEqual(post);
    expect(parsePost({ ...post, images: ['https://img/a.jpg', 'http://insecure', 3] })?.images).toEqual(['https://img/a.jpg']);
    expect(parsePost({ ...post, author: 3 })).toBeNull();
  });
});
