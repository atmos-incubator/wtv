import { describe, expect, it } from 'vitest';
import { pagesToReopen, parseNote } from './reload';

const base = 'chrome-extension://abc/';

describe('pagesToReopen', () => {
  it('keeps the playlists and options pages, with where they were', () => {
    const tabs = [
      { url: `${base}playlists.html?id=p1`, windowId: 1, index: 3, active: true },
      { url: `${base}options.html`, windowId: 2, index: 0, pinned: true },
      { url: `${base}card.html?gen=4`, windowId: 1, index: 4 },
      { url: 'https://example.com/', windowId: 1, index: 5 },
      { url: `${base}playlists.html` },
    ];
    expect(pagesToReopen(tabs, base)).toEqual([
      { url: `${base}playlists.html?id=p1`, windowId: 1, index: 3, active: true, pinned: false },
      { url: `${base}options.html`, windowId: 2, index: 0, active: false, pinned: true },
    ]);
  });
});

describe('parseNote', () => {
  const note = { at: 1000, tabs: [{ url: `${base}playlists.html`, windowId: 1, index: 0, active: true, pinned: false }], draft: { id: 'p1', name: 'A', text: 'x' } };

  it('reads a fresh note', () => {
    expect(parseNote(note, 2000, base)).toEqual(note);
  });

  it('ignores a stale or broken one', () => {
    expect(parseNote(note, 1000 + 61_000, base)).toBeNull();
    expect(parseNote({ tabs: [] }, 0, base)).toBeNull();
    expect(parseNote({ ...note, draft: { id: 5 } }, 2000, base)?.draft).toBeNull();
  });
});
