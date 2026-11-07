import { describe, expect, it } from 'vitest';
import { createMemoryArea } from '../testing/memory-area';
import { KEYS } from '../storage';
import { originPatternsFor, sameEntryUrl } from './match';
import {
  PL_APPLY,
  PL_COMMAND,
  PL_HELLO,
  PL_MEDIA,
  PL_STATE,
  parseEntryInfo,
  parsePlaylistApply,
  parsePlaylistRequest,
} from './messages';
import { addToPlaylist, deletePlaylist, getPlaylist, listPlaylists, nextPlaylistName, savePlaylist } from './store';

describe('sameEntryUrl', () => {
  const entry = 'https://www.youtube.com/watch?v=abc';

  it('ignores www / m., extra params, trailing slashes and the hash', () => {
    expect(sameEntryUrl('https://youtube.com/watch?v=abc&pp=x&t=5#wtv:t=1', entry)).toBe(true);
    expect(sameEntryUrl('https://m.youtube.com/watch?v=abc', entry)).toBe(true);
    expect(sameEntryUrl('https://a.com/show/', 'https://a.com/show')).toBe(true);
  });

  it('notices a different video or page', () => {
    expect(sameEntryUrl('https://www.youtube.com/watch?v=xyz', entry)).toBe(false);
    expect(sameEntryUrl('https://www.youtube.com/', entry)).toBe(false);
    expect(sameEntryUrl('https://vimeo.com/watch?v=abc', entry)).toBe(false);
    expect(sameEntryUrl('not a url', entry)).toBe(false);
  });

  it('builds deduplicated permission patterns', () => {
    expect(originPatternsFor([entry, 'https://www.youtube.com/watch?v=2', 'https://Vimeo.com/1', 'nope'])).toEqual([
      '*://vimeo.com/*',
      '*://www.youtube.com/*',
    ]);
  });
});

describe('playlist store', () => {
  it('creates, names, lists, updates and deletes', async () => {
    const area = createMemoryArea();
    const a = await savePlaylist(area, { name: '  Sunday   night ', text: 'https://a.com/1\n' }, 1);
    const b = await savePlaylist(area, { name: '', text: '' }, 2);
    expect(a.name).toBe('Sunday night');
    expect(b.name).toBe('Playlist 1');
    expect((await listPlaylists(area)).map((p) => p.name)).toEqual(['Playlist 1', 'Sunday night']);

    const updated = await savePlaylist(area, { id: a.id, name: 'Renamed', text: 'x' }, 5);
    expect(updated).toMatchObject({ id: a.id, createdAt: 1, updatedAt: 5, text: 'x' });

    await deletePlaylist(area, b.id);
    expect(await getPlaylist(area, b.id)).toBeNull();
  });

  it('appends URLs to existing or new playlists, keeping the text', async () => {
    const area = createMemoryArea();
    const p = await savePlaylist(area, { name: 'Mine', text: '# keep me\nhttps://a.com/1\n' });
    await addToPlaylist(area, p.id, 'https://a.com/2', 'Two');
    expect((await getPlaylist(area, p.id))?.text).toBe('# keep me\nhttps://a.com/1\n\nhttps://a.com/2 | Two\n');

    const fresh = await addToPlaylist(area, null, 'https://b.com/x', null);
    expect(fresh).toMatchObject({ name: 'Playlist 1', text: 'https://b.com/x\n' });
    await expect(addToPlaylist(area, 'pl-missing', 'https://b.com/x', null)).rejects.toThrow();
  });

  it('drops malformed stored records', async () => {
    const area = createMemoryArea({ [KEYS.playlists]: { a: { id: 'a', name: 1 }, b: 'junk' } });
    expect(await listPlaylists(area)).toEqual([]);
  });

  it('picks the first free default name', () => {
    expect(nextPlaylistName([{ name: 'Playlist 1' }, { name: 'Playlist 3' }])).toBe('Playlist 2');
  });
});

describe('playlist messages', () => {
  it('parses runner requests', () => {
    expect(parsePlaylistRequest({ type: PL_HELLO })).toEqual({ type: PL_HELLO });
    expect(parsePlaylistRequest({ type: PL_MEDIA, gen: 3, event: 'ended' })).toEqual({
      type: PL_MEDIA,
      gen: 3,
      event: 'ended',
    });
    expect(parsePlaylistRequest({ type: PL_MEDIA, gen: 3, event: 'boom' })).toBeNull();
    expect(parsePlaylistRequest({ type: PL_COMMAND, op: 'start', playlistId: 'p', index: 0, tv: true })).toEqual({
      type: PL_COMMAND,
      op: 'start',
      playlistId: 'p',
      index: 0,
      tv: true,
    });
    expect(parsePlaylistRequest({ type: PL_COMMAND, op: 'start', playlistId: 'p', index: -1, tv: true })).toBeNull();
    expect(parsePlaylistRequest({ type: PL_COMMAND, op: 'next' })).toEqual({ type: PL_COMMAND, op: 'next', tabId: null });
    expect(parsePlaylistRequest({ type: PL_STATE, tabId: 4 })).toEqual({ type: PL_STATE, tabId: 4 });
    expect(parsePlaylistRequest({ type: 'wtv/view/state' })).toBeNull();
  });

  it('parses apply messages and entry info', () => {
    expect(parsePlaylistApply({ type: PL_APPLY, op: 'blackout', title: 'T' })).toEqual({
      type: PL_APPLY,
      op: 'blackout',
      title: 'T',
    });
    expect(parsePlaylistApply({ type: PL_APPLY, op: 'blocked' })).toEqual({ type: PL_APPLY, op: 'blocked' });
    expect(parsePlaylistApply({ type: PL_APPLY, op: 'nope' })).toBeNull();
    expect(
      parseEntryInfo({
        gen: 1,
        index: 0,
        total: 2,
        playlist: 'P',
        title: '',
        startS: 97,
        ads: [{ kind: 'img', keyword: 'cats', durationS: null }, { kind: 'bad' }],
      }),
    ).toEqual({
      gen: 1,
      index: 0,
      total: 2,
      playlist: 'P',
      title: null,
      startS: 97,
      ads: [{ kind: 'img', keyword: 'cats', durationS: null }],
      // From a runner started before views existed.
      view: 'video',
      show: null,
    });
    expect(
      parseEntryInfo({
        gen: 1,
        index: 0,
        total: 1,
        playlist: 'P',
        view: 'pictures',
        show: [{ kind: 'text', text: 'Now playing', durationS: 10 }],
      }),
    ).toMatchObject({ view: 'pictures', show: [{ kind: 'text', text: 'Now playing', durationS: 10 }] });
    expect(parseEntryInfo({ gen: 1, index: 0, total: 1, playlist: 'P', view: 'tv' })?.view).toBe('video');
    expect(parseEntryInfo(null)).toBeNull();
  });
});
