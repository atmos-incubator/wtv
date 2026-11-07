import { describe, expect, it } from 'vitest';
import { cleanText, extractMetadata, headIsStale, parseDuration, type PageFacts } from './extract';

const WATCH = 'https://www.youtube.com/watch?v=AAA&t=10s';

/** A YouTube-like watch page as first loaded: JSON-LD, OpenGraph and head tags all agree. */
function youtube(overrides: Partial<PageFacts> = {}): PageFacts {
  return {
    url: WATCH,
    documentTitle: '(3) First video - YouTube',
    jsonLd: [
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name: 'First video',
        description: 'About the first video &amp; more',
        duration: 'PT4M13S',
        thumbnailUrl: ['https://i.ytimg.com/vi/AAA/maxresdefault.jpg', 'https://i.ytimg.com/vi/AAA/hq.jpg'],
        author: 'Some Channel',
        embedUrl: 'https://www.youtube.com/embed/AAA',
      }),
    ],
    tags: [
      { key: 'og:url', value: 'https://www.youtube.com/watch?v=AAA' },
      { key: 'og:title', value: 'First video' },
      { key: 'og:image', value: 'https://i.ytimg.com/vi/AAA/og.jpg' },
      { key: 'og:video:tag', value: 'cats' },
      { key: 'og:video:tag', value: 'funny' },
      { key: 'title', value: 'First video' },
      { key: 'description', value: 'Head description' },
      { key: 'keywords', value: 'cats, funny, Cats' },
    ],
    canonical: 'https://www.youtube.com/watch?v=AAA',
    roles: {
      title: { value: 'First video', yours: false },
      creator: { value: 'Some Channel', yours: false },
    },
    ...overrides,
  };
}

describe('parseDuration', () => {
  it('reads ISO 8601 durations and plain seconds', () => {
    expect(parseDuration('PT4M13S')).toBe(253);
    expect(parseDuration('PT1H2M3S')).toBe(3723);
    expect(parseDuration('P1DT1S')).toBe(86401);
    expect(parseDuration('pt30s')).toBe(30);
    expect(parseDuration('PT1.5S')).toBe(1.5);
    expect(parseDuration('253')).toBe(253);
  });

  it('rejects junk', () => {
    for (const bad of ['', 'P', 'PT', 'P1DT', '4:13', 'PT4X', 'soon']) expect(parseDuration(bad)).toBeNull();
  });
});

describe('cleanText', () => {
  it('decodes entities and collapses whitespace', () => {
    expect(cleanText('  Tom &amp; Jerry\n\n &#39;95 &#x2014; &quot;live&quot; ')).toBe('Tom & Jerry \'95 — "live"');
    expect(cleanText('&bogus; &#0;')).toBe('&bogus; &#0;');
  });
});

describe('extractMetadata', () => {
  it('prefers JSON-LD, then OpenGraph, meta tags, site selectors and the page title', () => {
    const m = extractMetadata(youtube());
    expect(m).toMatchObject({
      title: 'First video',
      creator: 'Some Channel',
      description: 'About the first video & more',
      keywords: ['cats', 'funny'],
      thumbnail: 'https://i.ytimg.com/vi/AAA/maxresdefault.jpg',
      duration: 253,
      staleHead: false,
    });
    expect(m.sources).toEqual({
      title: 'jsonld',
      creator: 'jsonld',
      description: 'jsonld',
      keywords: 'opengraph',
      thumbnail: 'jsonld',
      duration: 'jsonld',
    });
  });

  it('keeps every distinct value for the preview, winner first', () => {
    const m = extractMetadata(youtube());
    expect(m.candidates.description.map((c) => [c.source, c.detail])).toEqual([
      ['jsonld', 'VideoObject.description'],
      ['meta', 'description'],
    ]);
    // og:title, the title tag and the site selector all say "First video": kept once.
    expect(m.candidates.title.map((c) => [c.source, c.value])).toEqual([
      ['jsonld', 'First video'],
      ['page', 'First video - YouTube'],
    ]);
  });

  it('ignores a head left over from the previous page after in-app navigation', () => {
    const m = extractMetadata(
      youtube({
        url: 'https://www.youtube.com/watch?v=BBB',
        documentTitle: 'Second video - YouTube',
        jsonLd: [],
        roles: {
          title: { value: 'Second video', yours: false },
          creator: { value: 'Other Channel', yours: false },
        },
      }),
    );
    expect(m.staleHead).toBe(true);
    expect(m.title).toBe('Second video');
    expect(m.sources.title).toBe('selector');
    expect(m.creator).toBe('Other Channel');
    expect(m.description).toBeNull();
    expect(m.keywords).toEqual([]);
    expect(m.thumbnail).toBeNull();
  });

  it('puts the user’s own selector first', () => {
    const m = extractMetadata(youtube({ roles: { title: { value: 'My pick', yours: true } } }));
    expect(m.title).toBe('My pick');
    expect(m.sources.title).toBe('yours');
    expect(m.candidates.title.map((c) => c.source)).toEqual(['yours', 'jsonld', 'page']);
  });

  it('falls back to the page title, without a notification count', () => {
    const m = extractMetadata({
      url: 'https://example.com/v/1',
      documentTitle: '(12) Just a page',
      jsonLd: [],
      tags: [],
      canonical: null,
      roles: {},
    });
    expect(m.title).toBe('Just a page');
    expect(m.sources).toEqual({ title: 'page' });
  });

  it('finds media inside @graph and nested objects, and skips broken JSON-LD', () => {
    const m = extractMetadata({
      url: 'https://news.example/story',
      documentTitle: 'Story',
      jsonLd: [
        '{ not json',
        JSON.stringify({
          '@graph': [
            { '@type': 'WebPage', name: 'The page' },
            {
              '@type': ['NewsArticle'],
              headline: 'The story',
              author: [{ '@type': 'Person', name: 'Ann' }, { '@type': 'Person', name: 'Bob' }],
              video: { '@type': 'VideoObject', name: 'The clip', duration: 'PT1M', thumbnailUrl: '/clip.jpg' },
            },
          ],
        }),
      ],
      tags: [],
      canonical: null,
      roles: {},
    });
    // VideoObject wins over the article that contains it.
    expect(m.title).toBe('The clip');
    expect(m.duration).toBe(60);
    expect(m.thumbnail).toBe('https://news.example/clip.jpg');
    expect(m.candidates.title[0]?.detail).toBe('VideoObject.name');
  });

  it('joins JSON-LD authors when the article is the best item', () => {
    const m = extractMetadata({
      url: 'https://news.example/story',
      documentTitle: 'Story',
      jsonLd: [
        JSON.stringify({ '@type': 'Article', headline: 'The story', author: [{ name: 'Ann' }, { name: 'Bob' }], keywords: ['a', 'b'] }),
      ],
      tags: [],
      canonical: null,
      roles: {},
    });
    expect(m.title).toBe('The story');
    expect(m.creator).toBe('Ann, Bob');
    expect(m.keywords).toEqual(['a', 'b']);
  });

  it('skips a JSON-LD item about another page of the same site, but trusts embedded videos', () => {
    const stale = JSON.stringify({ '@type': 'VideoObject', name: 'Old', url: 'https://www.youtube.com/watch?v=OLD' });
    const embed = JSON.stringify({ '@type': 'VideoObject', name: 'Embedded', url: 'https://vimeo.com/123' });
    const base = { documentTitle: 'Page', tags: [], canonical: null, roles: {} };
    expect(extractMetadata({ ...base, url: WATCH, jsonLd: [stale] }).title).toBe('Page');
    expect(extractMetadata({ ...base, url: WATCH, jsonLd: [embed] }).title).toBe('Embedded');
    expect(
      extractMetadata({ ...base, url: 'https://www.youtube.com/watch?v=OLD', jsonLd: [stale] }).title,
    ).toBe('Old');
  });

  it('reads microdata and OpenGraph durations, and ignores profile URLs as creators', () => {
    const m = extractMetadata({
      url: 'https://videos.example/watch/9',
      documentTitle: 'x',
      jsonLd: [],
      tags: [
        { key: 'itemprop:name', value: 'Microdata title' },
        { key: 'itemprop:duration', value: 'PT2M' },
        { key: 'og:video:duration', value: '125' },
        { key: 'article:author', value: 'https://videos.example/u/ann' },
        { key: 'itemprop:author.name', value: 'Ann' },
        { key: 'itemprop:thumbnailurl', value: 'https://img.example/9.jpg' },
      ],
      canonical: null,
      roles: {},
    });
    expect(m.title).toBe('Microdata title');
    expect(m.duration).toBe(125);
    expect(m.candidates.duration.map((c) => c.value)).toEqual(['125', '120']);
    expect(m.creator).toBe('Ann');
    expect(m.thumbnail).toBe('https://img.example/9.jpg');
  });

  it('drops non-http thumbnails', () => {
    const m = extractMetadata({
      url: 'https://example.com/',
      documentTitle: 'x',
      jsonLd: [],
      tags: [{ key: 'og:image', value: 'javascript:alert(1)' }],
      canonical: null,
      roles: {},
    });
    expect(m.thumbnail).toBeNull();
  });
});

describe('headIsStale', () => {
  it('uses og:url, then the canonical link', () => {
    const page = 'https://www.youtube.com/watch?v=BBB&list=X';
    expect(headIsStale({ url: page, tags: [{ key: 'og:url', value: '/watch?v=BBB' }], canonical: null })).toBe(false);
    expect(headIsStale({ url: page, tags: [{ key: 'og:url', value: '/watch?v=AAA' }], canonical: null })).toBe(true);
    expect(headIsStale({ url: page, tags: [], canonical: 'https://m.youtube.com/watch?v=BBB' })).toBe(false);
    expect(headIsStale({ url: page, tags: [], canonical: 'https://youtube.com/watch?v=AAA' })).toBe(true);
    expect(headIsStale({ url: page, tags: [], canonical: null })).toBe(false);
  });
});
