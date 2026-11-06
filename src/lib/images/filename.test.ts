import { describe, expect, it } from 'vitest';
import { parseImageFilename } from './filename';

describe('parseImageFilename', () => {
  it('parses a plain image', () => {
    expect(parseImageFilename('Cat.JPG')).toEqual({ stem: 'cat', durationMs: null, kind: 'image', mime: 'image/jpeg' });
  });

  it('parses a seconds duration suffix', () => {
    expect(parseImageFilename('grumpy_cats_d10s.png')).toMatchObject({ stem: 'grumpy_cats', durationMs: 10_000 });
  });

  it('treats a bare number as seconds', () => {
    expect(parseImageFilename('relax_d20.webp')?.durationMs).toBe(20_000);
  });

  it('parses a minutes suffix and webm video', () => {
    expect(parseImageFilename('ocean_d2m.webm')).toEqual({
      stem: 'ocean',
      durationMs: 120_000,
      kind: 'video',
      mime: 'video/webm',
    });
  });

  it('ignores a zero duration', () => {
    expect(parseImageFilename('x_d0s.png')).toMatchObject({ stem: 'x', durationMs: null });
  });

  it('only treats the suffix at the end as a duration', () => {
    expect(parseImageFilename('my_d5s_cat.png')).toMatchObject({ stem: 'my_d5s_cat', durationMs: null });
  });

  it.each(['.DS_Store', 'notes.txt', 'noext', '_d5s.png', '.hidden.png'])('rejects %s', (name) => {
    expect(parseImageFilename(name)).toBeNull();
  });
});
