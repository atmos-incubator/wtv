import { describe, expect, it } from 'vitest';
import { carryVolumes, locateEntry, withEntryVolume } from './volume-edit';

const A = 'https://www.youtube.com/watch?v=a';
const B = 'https://www.youtube.com/watch?v=b';

describe('locateEntry', () => {
  it('finds the entry at its index, else the only one with its URL', () => {
    const entries = [{ url: A }, { url: B }];
    expect(locateEntry(entries, 1, B)).toBe(1);
    expect(locateEntry(entries, 0, B)).toBe(1);
    expect(locateEntry([{ url: 'https://youtube.com/watch?v=a&t=5' }], 0, A)).toBe(0);
    expect(locateEntry([{ url: B }, { url: B }], 2, B)).toBe(-1);
    expect(locateEntry(entries, 0, 'https://vimeo.com/1')).toBe(-1);
  });
});

describe('withEntryVolume', () => {
  it('sets vol= on the entry, wherever it has moved to', () => {
    expect(withEntryVolume(`${A}\n${B} | Bee\n`, 1, B, 0.6)).toBe(`${A}\n${B} | Bee | vol=60\n`);
    expect(withEntryVolume(`# new line\n${B} | vol=20\n${A}\n`, 0, A, 0.3)).toBe(`# new line\n${B} | vol=20\n${A} | vol=30\n`);
    expect(withEntryVolume(`${A} | vol=20\n`, 0, A, null)).toBe(`${A}\n`);
    expect(withEntryVolume(`${A}\n`, 0, B, 0.5)).toBeNull();
  });
});

describe('carryVolumes', () => {
  it('makes the saved copy’s vol= change to unsaved edits, and nothing else', () => {
    const before = `${A} | First\n${B}\n`;
    const after = `${A} | First | vol=70\n${B}\n`;
    const draft = `# my notes\n${A} | First, renamed\n${B} | t=30\n`;
    expect(carryVolumes(before, after, draft)).toEqual({
      text: `# my notes\n${A} | First, renamed | vol=70\n${B} | t=30\n`,
      entries: [0],
    });
  });

  it('leaves the edits alone when nothing about volume changed, or the entry is gone from them', () => {
    expect(carryVolumes(`${A}\n`, `${A} | Renamed\n`, `${A} | Mine\n`)).toEqual({ text: `${A} | Mine\n`, entries: [] });
    expect(carryVolumes(`${A}\n`, `${A} | vol=40\n`, `${B}\n`)).toEqual({ text: `${B}\n`, entries: [] });
  });
});
