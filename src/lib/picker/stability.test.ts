import { describe, expect, it } from 'vitest';
import { cssString, isStableAttrValue, isStableClass, isStableId, looksGenerated } from './stability';

describe('looksGenerated', () => {
  it.each(['css-1x9f2a', 'sc-bdVaJa', 'Button_root__a1b2c', 'a1b2c3d4', 'item-12345', 'x9y8z7', ''])(
    'flags %s',
    (token) => {
      expect(looksGenerated(token)).toBe(true);
    },
  );

  it.each(['ytp-skip-ad-button', 'html5-main-video', 'movie_player', 'video-title', 'ytd-watch-metadata', 'title'])(
    'accepts %s',
    (token) => {
      expect(looksGenerated(token)).toBe(false);
    },
  );
});

describe('isStableClass', () => {
  it('rejects state classes', () => {
    expect(isStableClass('active')).toBe(false);
    expect(isStableClass('is-open')).toBe(false);
    expect(isStableClass('playing')).toBe(false);
  });

  it('accepts descriptive classes', () => {
    expect(isStableClass('ytp-play-button')).toBe(true);
  });
});

describe('isStableId', () => {
  it('rejects framework ids', () => {
    expect(isStableId(':r1:')).toBe(false);
    expect(isStableId('ember123')).toBe(false);
    expect(isStableId('radix-dialog')).toBe(false);
  });

  it('accepts descriptive ids', () => {
    expect(isStableId('movie_player')).toBe(true);
  });
});

describe('isStableAttrValue', () => {
  it('accepts short descriptive values', () => {
    expect(isStableAttrValue('video-player')).toBe(true);
    expect(isStableAttrValue('name')).toBe(true);
  });

  it('rejects empty, long, multi-line and hashed values', () => {
    expect(isStableAttrValue('  ')).toBe(false);
    expect(isStableAttrValue('x'.repeat(81))).toBe(false);
    expect(isStableAttrValue('a\nb')).toBe(false);
    expect(isStableAttrValue('f3a9c2e1')).toBe(false);
  });
});

describe('cssString', () => {
  it('quotes and escapes', () => {
    expect(cssString('say "hi"')).toBe('"say \\"hi\\""');
    expect(cssString('a\\b')).toBe('"a\\\\b"');
  });
});
