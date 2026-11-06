import { describe, expect, it } from 'vitest';
import { classifyPath, domainFolderFor, resolveImages, type ImageMeta } from './library';

describe('classifyPath', () => {
  it('places top-level files', () => {
    expect(classifyPath([])).toEqual({ domain: null, folder: null });
  });

  it('treats dotted folders as domains and others as keywords', () => {
    expect(classifyPath(['YouTube.com'])).toEqual({ domain: 'youtube.com', folder: null });
    expect(classifyPath(['Cats'])).toEqual({ domain: null, folder: 'cats' });
  });

  it('allows one keyword level inside a domain folder', () => {
    expect(classifyPath(['youtube.com', 'Cats'])).toEqual({ domain: 'youtube.com', folder: 'cats' });
  });

  it('skips anything deeper', () => {
    expect(classifyPath(['cats', 'more'])).toBeNull();
    expect(classifyPath(['youtube.com', 'cats', 'more'])).toBeNull();
    expect(classifyPath(['youtube.com', 'vimeo.com'])).toBeNull();
  });
});

let n = 0;
function img(domain: string | null, folder: string | null, stem: string): ImageMeta {
  return {
    id: `${domain ?? ''}/${folder ?? ''}/${stem}-${n++}`,
    domain,
    folder,
    stem,
    durationMs: null,
    kind: 'image',
    mime: 'image/png',
  };
}

const lib = [
  img(null, null, 'relax'),
  img(null, null, 'sleepy_cats'),
  img(null, 'cats', 'tabby'),
  img(null, 'dogs', 'corgi'),
  img('youtube.com', null, 'grumpy_cats'),
  img('youtube.com', null, 'sunset'),
  img('youtube.com', 'birds', 'parrot'),
  img('music.youtube.com', null, 'vinyl'),
];

const stems = (r: ImageMeta[]) => r.map((m) => m.stem).sort();

describe('domainFolderFor', () => {
  it('picks the most specific matching domain folder', () => {
    expect(domainFolderFor('music.youtube.com', lib)).toBe('music.youtube.com');
    expect(domainFolderFor('www.youtube.com', lib)).toBe('youtube.com');
    expect(domainFolderFor('vimeo.com', lib)).toBeNull();
  });
});

describe('resolveImages with a keyword', () => {
  it('1. prefers the domain keyword folder', () => {
    expect(stems(resolveImages(lib, 'www.youtube.com', 'birds'))).toEqual(['parrot']);
  });

  it('2. then domain top-level files with the keyword in the name', () => {
    expect(stems(resolveImages(lib, 'www.youtube.com', 'cats'))).toEqual(['grumpy_cats']);
  });

  it('3. then the top-level keyword folder', () => {
    expect(stems(resolveImages(lib, 'www.youtube.com', 'dogs'))).toEqual(['corgi']);
  });

  it('4. then top-level files with the keyword in the name', () => {
    expect(stems(resolveImages(lib, 'www.youtube.com', 'relax'))).toEqual(['relax']);
  });

  it('skips domain steps for sites without a domain folder', () => {
    expect(stems(resolveImages(lib, 'vimeo.com', 'cats'))).toEqual(['tabby']);
  });

  it('is case-insensitive', () => {
    expect(stems(resolveImages(lib, 'vimeo.com', 'CATS'))).toEqual(['tabby']);
  });

  it('returns nothing (use bundled) when nothing matches', () => {
    expect(resolveImages(lib, 'www.youtube.com', 'llamas')).toEqual([]);
  });
});

describe('resolveImages without a keyword', () => {
  it('uses the domain folder top level', () => {
    expect(stems(resolveImages(lib, 'youtube.com', null))).toEqual(['grumpy_cats', 'sunset']);
  });

  it('uses the most specific domain folder', () => {
    expect(stems(resolveImages(lib, 'music.youtube.com', null))).toEqual(['vinyl']);
  });

  it('falls back to top-level files', () => {
    expect(stems(resolveImages(lib, 'vimeo.com', null))).toEqual(['relax', 'sleepy_cats']);
  });

  it('treats a blank keyword as none', () => {
    expect(stems(resolveImages(lib, 'vimeo.com', '  '))).toEqual(['relax', 'sleepy_cats']);
  });

  it('returns nothing for an empty library', () => {
    expect(resolveImages([], 'youtube.com', null)).toEqual([]);
  });
});
