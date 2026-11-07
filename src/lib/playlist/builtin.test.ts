import { describe, expect, it } from 'vitest';
import { checkSvg, isBuiltinId, loadBuiltinPlaylists } from './builtin';
import { BUILTIN_LOAD_RESULT } from './builtin-bundle';

describe('shipped built-in playlists (src/playlists/)', () => {
  it('are all valid', () => {
    expect(BUILTIN_LOAD_RESULT.errors).toEqual([]);
  });
});

describe('loadBuiltinPlaylists', () => {
  const cats = '# name: Cat videos\n[shuffle]\nhttps://www.youtube.com/watch?v=abc | Cat\n';

  it('loads named playlists with their covers, sorted by name', () => {
    const r = loadBuiltinPlaylists(
      { '/x/playlists/cats.txt': cats, '/x/playlists/art.txt': '# Name:  Artwork \nhttps://a.com/1\n' },
      { '/x/playlists/cats.svg': '/assets/cats.svg' },
    );
    expect(r.errors).toEqual([]);
    expect(r.playlists.map((p) => [p.id, p.name, p.cover])).toEqual([
      ['builtin-art', 'Artwork', null],
      ['builtin-cats', 'Cat videos', '/assets/cats.svg'],
    ]);
    expect(r.playlists[1]!.text).toBe(cats);
    expect(isBuiltinId(r.playlists[0]!.id)).toBe(true);
    expect(isBuiltinId('pl-0123')).toBe(false);
  });

  it('skips stubs with a note, and notes stray covers', () => {
    const r = loadBuiltinPlaylists({ 'nature.txt': '# name: Nature\n# coming soon\n' }, { 'other.svg': 'x' });
    expect(r.playlists).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual(['playlists/nature.txt: no entries yet, not shipped', 'playlists/other.svg: no other.txt beside it, ignored']);
  });

  it('rejects files without a name line, bad file names, and any format problem', () => {
    const r = loadBuiltinPlaylists({
      'noname.txt': 'https://a.com/1\n',
      'Bad_Name.txt': '# name: X\nhttps://a.com/1\n',
      'broken.txt': '# name: Broken\nhttps://a.com/1 | t=soon\nnot a line\n',
    });
    expect(r.playlists).toEqual([]);
    expect(r.errors).toEqual([
      'playlists/Bad_Name.txt: file names are lowercase letters, digits and dashes',
      'playlists/broken.txt:2: t=soon is not a timestamp',
      expect.stringMatching(/^playlists\/broken\.txt:3: not a URL/),
      'playlists/noname.txt: the first line must be "# name: <Playlist name>"',
    ]);
  });
});

describe('checkSvg', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="16" height="9"/><use href="#g"/></svg>';

  it('accepts a plain SVG', () => {
    expect(checkSvg(ok, ok.length)).toEqual([]);
    expect(checkSvg(`<?xml version="1.0"?>\n<!-- cover -->\n${ok}`, 100)).toEqual([]);
  });

  it('rejects anything that could run or load something', () => {
    expect(checkSvg('<html><svg/></html>', 10)).toEqual(['not an SVG (it must start with <svg>)']);
    expect(checkSvg('<svg><script>alert(1)</script></svg>', 10)).toEqual(['contains a <script>']);
    expect(checkSvg('<svg onload="x()"></svg>', 10)).toEqual(['contains an event handler attribute (on…=)']);
    expect(checkSvg('<svg><image href="https://evil.example/a.png"/></svg>', 10)).toEqual([
      'references https://evil.example/a.png (only #fragment links are allowed)',
    ]);
    expect(checkSvg('<svg><rect style="fill:url(https://x/y)"/></svg>', 10)).toEqual(['contains a url(…) that isn’t a #fragment']);
    expect(checkSvg('<svg><foreignObject/></svg>', 10)).toEqual(['contains a <foreignObject>']);
    expect(checkSvg(ok, 60 * 1024)).toEqual(['60 kB; the limit is 50 kB']);
  });
});
