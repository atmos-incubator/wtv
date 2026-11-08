import { describe, expect, it } from 'vitest';
import {
  ALL_POST_API_HOSTS,
  BLUESKY_ADAPTER,
  CARD_MAX_S,
  CARD_MIN_S,
  REDDIT_ADAPTER,
  X_ADAPTER,
  cardDurationS,
  decodeEntities,
  findPostAdapter,
  formatDate,
  htmlToText,
  parseBlueskyThread,
  parsePost,
  parseRedditFeed,
  parseXOembed,
  postFetchHosts,
  postTitle,
  type Post,
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

/** www.reddit.com's feed for a picture post (November 2026): the post's entry. */
const REDDIT_PICTURE = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:media=\"http://search.yahoo.com/mrss/\"><title>x</title><entry><author><name>/u/MrMaxweld</name><uri>https://www.reddit.com/user/MrMaxweld</uri></author><category term=\"pics\" label=\"r/pics\"/><content type=\"html\">&lt;table&gt; &lt;tr&gt;&lt;td&gt; &lt;a href=&quot;https://www.reddit.com/r/pics/comments/1xqocwf/snapped_a_shot_of_a_welding_student_in_the_zone/&quot;&gt; &lt;img src=&quot;https://preview.redd.it/ugoie35k2b0i1.jpeg?width=640&amp;amp;crop=smart&amp;amp;auto=webp&amp;amp;s=787bf316801d158d8d519fd253cacb23b1eb767c&quot; alt=&quot;Snapped a shot of a welding student in the zone&quot; title=&quot;Snapped a shot of a welding student in the zone&quot; /&gt; &lt;/a&gt; &lt;/td&gt;&lt;td&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/MrMaxweld&quot;&gt; /u/MrMaxweld &lt;/a&gt; &amp;#32; to &amp;#32; &lt;a href=&quot;https://www.reddit.com/r/pics/&quot;&gt; r/pics &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://i.redd.it/ugoie35k2b0i1.jpeg&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/pics/comments/1xqocwf/snapped_a_shot_of_a_welding_student_in_the_zone/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt; &lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content><id>t3_1xqocwf</id><media:thumbnail url=\"https://preview.redd.it/ugoie35k2b0i1.jpeg?width=640&amp;crop=smart&amp;auto=webp&amp;s=787bf316801d158d8d519fd253cacb23b1eb767c\" /><link href=\"https://www.reddit.com/r/pics/comments/1xqocwf/snapped_a_shot_of_a_welding_student_in_the_zone/\" /><updated>2026-11-08T03:10:46+00:00</updated><published>2026-11-08T03:10:46+00:00</published><title>Snapped a shot of a welding student in the zone</title></entry></feed>";

/** …and for a text post (its body trimmed to the first and last parts). */
const REDDIT_TEXT = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:media=\"http://search.yahoo.com/mrss/\"><title>x</title><entry><author><name>/u/AITAMod</name><uri>https://www.reddit.com/user/AITAMod</uri></author><category term=\"AmItheAsshole\" label=\"r/AmItheAsshole\"/><content type=\"html\">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;&lt;strong&gt;AITA Quarterly Open Forum Oct - Dec 2026&lt;/strong&gt; &lt;/p&gt; &lt;h2&gt;Keep things Civil! Rules still apply.&lt;/h2&gt; &lt;hr/&gt; &lt;p&gt;As always, do not directly link to posts/comments or post uncensored screenshots here. Any comments with links will be removed.&lt;/p&gt; &lt;p&gt;We&amp;#39;d like to highlight the regional spinoffs we have linked on the sidebar! If you have any suggestions or additions to this, please let us know in the comments.&lt;/p&gt; &lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/AITAMod&quot;&gt; /u/AITAMod &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/AmItheAsshole/comments/1wx12yz/aita_quarterly_open_forum_oct_dec_2026/&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/AmItheAsshole/comments/1wx12yz/aita_quarterly_open_forum_oct_dec_2026/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content><id>t3_1wx12yz</id><link href=\"https://www.reddit.com/r/AmItheAsshole/comments/1wx12yz/aita_quarterly_open_forum_oct_dec_2026/\" /><updated>2026-10-03T23:31:39+00:00</updated><published>2026-10-03T23:31:39+00:00</published><title>AITA Quarterly Open Forum Oct - Dec 2026</title></entry></feed>";

/** public.api.bsky.app's getPostThread for a post with four pictures (November 2026; trimmed). */
const BSKY_THREAD = {
  "thread": {
    "$type": "app.bsky.feed.defs#threadViewPost",
    "post": {
      "uri": "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3myx7vphq3s2j",
      "author": {
        "did": "did:plc:z72i7hdynmk6r22z27h6tvur",
        "handle": "bsky.app",
        "displayName": "Bluesky",
        "labels": []
      },
      "record": {
        "$type": "app.bsky.feed.post",
        "createdAt": "2026-10-28T16:58:02.827Z",
        "text": "getting our Halloween decorations set up"
      },
      "embed": {
        "$type": "app.bsky.embed.images#view",
        "images": [
          {
            "thumb": "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreienhu3nspbm2f2v5q74arjtlvltdlgruzjvo6ndlggksp6l6zlf5a",
            "fullsize": "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreienhu3nspbm2f2v5q74arjtlvltdlgruzjvo6ndlggksp6l6zlf5a",
            "alt": "Gravestone reading:\n\nHere lies StumbleUpon\n2001 - 2018\n\"Remember websites?\""
          },
          {
            "thumb": "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreifpa3vyizusbzwgmnpr4wgm4nhsztxolgvjr4gmzspmpwysltrnre",
            "fullsize": "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreifpa3vyizusbzwgmnpr4wgm4nhsztxolgvjr4gmzspmpwysltrnre",
            "alt": "Gravestone reading:\n\nHere lies Vine\n2013 - 2017\n\"Look at all those chickens\""
          },
          {
            "thumb": "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreienq5z3pmk3h6yiqyfmuf7lvux6mknnfol4akfrn4fh5l7qngkwo4",
            "fullsize": "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreienq5z3pmk3h6yiqyfmuf7lvux6mknnfol4akfrn4fh5l7qngkwo4",
            "alt": "Gravestone reading:\n\nHere lies AIM\n1997 - 2017\n\"BRB LOL\""
          },
          {
            "thumb": "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreicfsv73pv6l5az2ktk4ltxi5izmnuuakhhiufmr2hrj4yjp2htuyq",
            "fullsize": "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreicfsv73pv6l5az2ktk4ltxi5izmnuuakhhiufmr2hrj4yjp2htuyq",
            "alt": "Gravestone reading:\n\nHere lies Myspace\n2003 - ?\n\"Please add me to your top 8\""
          }
        ]
      },
      "labels": []
    }
  }
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
    expect(findPostAdapter('https://bsky.app/profile/a.bsky.social')).toBeNull();
    expect(findPostAdapter('https://www.reddit.com/r/pics/')).toBeNull();
    expect(findPostAdapter('https://www.reddit.com/r/pics/s/AbCdEf123')).toBeNull();
    expect(findPostAdapter('https://reddit.com.evil.example/r/a/comments/abc/')).toBeNull();
    expect(findPostAdapter('nope')).toBeNull();
  });

  it('fetches from oEmbed', () => {
    expect(X_ADAPTER.endpoint('https://x.com/a/status/1')).toBe(
      'https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1&omit_script=1&dnt=true',
    );
    expect(postFetchHosts(['https://x.com/a/status/1', 'https://twitter.com/b/status/2', 'https://a.com/'])).toEqual(['publish.x.com']);
  });

  it('asks for host access only where the endpoint needs it, and keeps watched sites scriptable', () => {
    expect(
      postFetchHosts(['https://x.com/a/status/1', 'https://www.reddit.com/r/pics/comments/abc/', 'https://bsky.app/profile/a.b/post/x']),
    ).toEqual(['publish.x.com', 'www.reddit.com']);
    expect(ALL_POST_API_HOSTS).toEqual(['publish.x.com', 'public.api.bsky.app']);
  });

  it('knows Reddit posts by any spelling', () => {
    for (const url of [
      'https://www.reddit.com/r/pics/comments/1xqocwf/snapped_a_shot/',
      'https://old.reddit.com/r/pics/comments/1xqocwf/',
      'https://reddit.com/r/pics/comments/1XQOCWF',
      'https://www.reddit.com/r/pics/comments/1xqocwf/snapped_a_shot/abc123/?context=3',
    ]) {
      expect(findPostAdapter(url)?.canonical).toBe('https://www.reddit.com/r/pics/comments/1xqocwf/');
    }
    expect(findPostAdapter('https://redd.it/1xqocwf')?.canonical).toBe('https://www.reddit.com/comments/1xqocwf/');
    expect(findPostAdapter('https://www.reddit.com/comments/1xqocwf')?.canonical).toBe('https://www.reddit.com/comments/1xqocwf/');
    expect(findPostAdapter('https://www.reddit.com/user/some-one/comments/1xqocwf/hi/')?.canonical).toBe(
      'https://www.reddit.com/comments/1xqocwf/',
    );
    expect(REDDIT_ADAPTER.endpoint('https://www.reddit.com/r/pics/comments/1xqocwf/')).toBe(
      'https://www.reddit.com/r/pics/comments/1xqocwf/.rss?limit=1',
    );
  });

  it('knows Bluesky posts by handle or DID', () => {
    expect(findPostAdapter('https://bsky.app/profile/Bsky.App/post/3myx7vphq3s2j')?.canonical).toBe(
      'https://bsky.app/profile/bsky.app/post/3myx7vphq3s2j',
    );
    expect(findPostAdapter('https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3myx7vphq3s2j')?.canonical).toBe(
      'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3myx7vphq3s2j',
    );
    expect(BLUESKY_ADAPTER.endpoint('https://bsky.app/profile/bsky.app/post/3myx7vphq3s2j')).toBe(
      'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at%3A%2F%2Fbsky.app%2Fapp.bsky.feed.post%2F3myx7vphq3s2j&depth=0&parentHeight=0',
    );
  });
});

describe('X oEmbed', () => {
  it('reads the text, author, handle and date, without the picture link', () => {
    expect(parseXOembed(OEMBED, 'https://x.com/Interior/status/463440424141459456')).toEqual({
      site: 'X',
      author: 'U.S. Department of the Interior',
      handle: '@Interior',
      title: null,
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
    expect(post?.text).toBe('one\ntwo <b>');
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

describe('X answers', () => {
  const url = 'https://x.com/Interior/status/463440424141459456';
  it('reads statuses', () => {
    expect(X_ADAPTER.read(200, JSON.stringify(OEMBED), url)).toMatchObject({ ok: true, post: { author: 'U.S. Department of the Interior' } });
    expect(X_ADAPTER.read(404, '', url)).toMatchObject({ ok: false, gone: true });
    expect(X_ADAPTER.read(403, '', url)).toMatchObject({ ok: false, gone: true });
    expect(X_ADAPTER.read(500, '', url)).toEqual({ ok: false, gone: false, error: 'X answered 500' });
    expect(X_ADAPTER.read(200, 'not json', url)).toMatchObject({ ok: false, gone: false });
  });
});

describe('Reddit feeds', () => {
  const pics = 'https://www.reddit.com/r/pics/comments/1xqocwf/';
  const aita = 'https://www.reddit.com/r/AmItheAsshole/comments/1wx12yz/';

  it('reads a picture post: title, author, community, the full picture', () => {
    expect(parseRedditFeed(REDDIT_PICTURE, pics)).toEqual({
      ok: true,
      post: {
        site: 'Reddit',
        author: 'u/MrMaxweld',
        handle: 'r/pics',
        title: 'Snapped a shot of a welding student in the zone',
        text: '',
        time: formatDate('2026-11-08T03:10:46+00:00'),
        url: pics,
        images: ['https://i.redd.it/ugoie35k2b0i1.jpeg'],
      },
    });
  });

  it('reads a text post\'s body as paragraphs, not Reddit\'s "submitted by" line', () => {
    const result = parseRedditFeed(REDDIT_TEXT, aita);
    expect(result).toMatchObject({ ok: true, post: { author: 'u/AITAMod', handle: 'r/AmItheAsshole', images: [] } });
    const post = (result as { post: Post }).post;
    expect(post.title).toBe('AITA Quarterly Open Forum Oct - Dec 2026');
    expect(post.text).toBe(
      'AITA Quarterly Open Forum Oct - Dec 2026\n\nKeep things Civil! Rules still apply.\n\n' +
        'As always, do not directly link to posts/comments or post uncensored screenshots here. Any comments with links will be removed.\n\n' +
        'We\'d like to highlight the regional spinoffs we have linked on the sidebar! If you have any suggestions or additions to this, please let us know in the comments.',
    );
    expect(post.text).not.toMatch(/submitted by|\[link\]/);
  });

  it('falls back to the preview, and takes pictures only from Reddit\'s hosts', () => {
    const gallery = REDDIT_PICTURE.replace('https://i.redd.it/ugoie35k2b0i1.jpeg', 'https://www.reddit.com/gallery/1xqocwf');
    expect((parseRedditFeed(gallery, pics) as { post: Post }).post.images).toEqual([
      'https://preview.redd.it/ugoie35k2b0i1.jpeg?width=640&crop=smart&auto=webp&s=787bf316801d158d8d519fd253cacb23b1eb767c',
    ]);
    const elsewhere = REDDIT_PICTURE.replaceAll('redd.it/', 'tracker.example/');
    expect((parseRedditFeed(elsewhere, pics) as { post: Post }).post.images).toEqual([]);
  });

  it('knows deleted and removed posts, and Reddit\'s refusals', () => {
    const removed = REDDIT_TEXT.replace(/SC_OFF --&gt;[\s\S]*?&lt;!-- SC_ON/, 'SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;[removed]&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON');
    expect(parseRedditFeed(removed, aita)).toMatchObject({ ok: false, gone: true });
    expect(REDDIT_ADAPTER.read(404, '', aita)).toMatchObject({ ok: false, gone: true });
    expect(REDDIT_ADAPTER.read(403, '', aita)).toMatchObject({ ok: false, gone: false });
    expect(REDDIT_ADAPTER.read(429, '', aita)).toMatchObject({ ok: false, gone: false });
    expect(REDDIT_ADAPTER.read(200, '<html>log in</html>', aita)).toEqual({ ok: false, gone: false, error: 'Couldn’t read Reddit’s answer' });
    expect(REDDIT_ADAPTER.read(200, REDDIT_TEXT, aita)).toMatchObject({ ok: true });
  });
});

describe('Bluesky threads', () => {
  const url = 'https://bsky.app/profile/bsky.app/post/3myx7vphq3s2j';
  const thread = BSKY_THREAD as unknown as { thread: { post: Record<string, unknown> & { author: Record<string, unknown> } } };

  it('reads the text, author, handle, date and pictures', () => {
    expect(parseBlueskyThread(BSKY_THREAD, url)).toEqual({
      ok: true,
      post: {
        site: 'Bluesky',
        author: 'Bluesky',
        handle: '@bsky.app',
        title: null,
        text: 'getting our Halloween decorations set up',
        time: formatDate('2026-10-28T16:58:02.827Z'),
        url,
        images: BSKY_THREAD.thread.post.embed.images.map((i) => i.fullsize),
      },
    });
  });

  it('leaves out pictures labelled adult, and posts their authors keep to signed-in people', () => {
    const adult = { thread: { ...thread.thread, post: { ...thread.thread.post, labels: [{ val: 'nudity' }] } } };
    expect((parseBlueskyThread(adult, url) as { post: Post }).post.images).toEqual([]);
    const hidden = {
      thread: { ...thread.thread, post: { ...thread.thread.post, author: { ...thread.thread.post.author, labels: [{ val: '!no-unauthenticated' }] } } },
    };
    expect(parseBlueskyThread(hidden, url)).toMatchObject({ ok: false, gone: true });
  });

  it('knows missing and blocked posts', () => {
    expect(BLUESKY_ADAPTER.read(400, '{"error":"NotFound","message":"Post not found"}', url)).toMatchObject({ ok: false, gone: true });
    expect(BLUESKY_ADAPTER.read(400, '{"error":"InvalidRequest"}', url)).toMatchObject({ ok: false, gone: false });
    expect(parseBlueskyThread({ thread: { $type: 'app.bsky.feed.defs#blockedPost' } }, url)).toMatchObject({ ok: false, gone: true });
    expect(BLUESKY_ADAPTER.read(200, JSON.stringify(BSKY_THREAD), url)).toMatchObject({ ok: true });
    expect(BLUESKY_ADAPTER.read(200, '{}', url)).toMatchObject({ ok: false, gone: false });
  });
});

describe('text from HTML', () => {
  it('keeps paragraphs and list items, drops comments and scripts', () => {
    expect(htmlToText('<!-- x --><p>One &amp; two</p><ul><li>a</li><li>b</li></ul><script>bad()</script><p>end</p>')).toBe(
      'One & two\n\n• a\n• b\n\nend',
    );
  });

  it('dates times', () => {
    expect(formatDate('2026-10-03T12:00:00Z')).toBe('October 3, 2026');
    expect(formatDate('nope')).toBeNull();
    expect(formatDate(null)).toBeNull();
  });
});

describe('cards', () => {
  it('stays up longer for longer posts, within limits', () => {
    const card = (text: string, title: string | null = null, images: string[] = []) => cardDurationS({ title, text, images });
    expect(card('hi')).toBe(CARD_MIN_S);
    expect(card('word '.repeat(30))).toBe(18);
    expect(card('word '.repeat(500))).toBe(CARD_MAX_S);
    expect(card('word '.repeat(20), 'word '.repeat(10))).toBe(18);
    expect(card('word '.repeat(30), null, ['a', 'b'])).toBe(24);
  });

  it('titles a post for the library', () => {
    const post = parseXOembed(OEMBED, 'https://x.com/Interior/status/463440424141459456')!;
    expect(postTitle(post)).toBe(`U.S. Department of the Interior: ${post.text}`);
    expect(postTitle({ ...post, text: 'x'.repeat(200) })).toMatch(/^U\.S\. Department of the Interior: x{79}…$/);
    expect(postTitle({ ...post, text: '' })).toBe('U.S. Department of the Interior');
    expect(postTitle({ ...post, title: 'A title' })).toBe('U.S. Department of the Interior: A title');
  });

  it('checks posts passed between pages', () => {
    const post = parseXOembed(OEMBED, 'https://x.com/Interior/status/463440424141459456')!;
    expect(parsePost(post)).toEqual(post);
    expect(parsePost({ ...post, images: ['https://img/a.jpg', 'http://insecure', 3] })?.images).toEqual(['https://img/a.jpg']);
    expect(parsePost({ ...post, author: 3 })).toBeNull();
    expect(parsePost({ ...post, title: 'T' })?.title).toBe('T');
    expect(parsePost({ ...post, images: ['https://1', 'https://2', 'https://3', 'https://4', 'https://5'] })?.images).toHaveLength(4);
  });
});
