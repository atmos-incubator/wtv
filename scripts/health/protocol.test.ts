import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MSG_STATUS as SRC_STATUS } from '../../src/lib/messages';
import { PICK_ROLES as SRC_ROLES } from '../../src/lib/picker/messages';
import { ROLE_NAMES } from '../../src/lib/sites/schema';
import { compilePlaylist, parsePlaylist } from '../../src/lib/playlist/format';
import {
  AD_ROLES,
  MOMENT_ROLES,
  MSG_STATUS,
  PICK_ROLES,
  evaluateRun,
  judgeEntry,
  judgeHttp,
  judgePost,
  parseBuiltinFile,
  parseTargets,
  playsVideo,
  summarize,
  summarizePlaylists,
  type EntryObservation,
  type Observation,
  type RoleLite,
} from './protocol';

const role = (name: string, matchedIndex: number | null, counts = [1]): RoleLite => ({
  role: name,
  matchedIndex,
  matchers: counts.map((count, i) => ({ selector: `.${name}-${i + 1}`, count, satisfied: i === matchedIndex, error: null })),
});

const good: Observation = {
  site: 'youtube.com',
  url: 'https://www.youtube.com/watch?v=x',
  finalUrl: 'https://www.youtube.com/watch?v=x',
  played: true,
  primarySource: 'config',
  roles: [role('video', 0), role('playButton', 0), role('title', 0), role('adIndicator', null, [0]), role('skip', null, [0])],
  adSeen: false,
  skipSeen: false,
  error: null,
};

describe('health runner protocol', () => {
  it('stays in sync with the extension', () => {
    expect(MSG_STATUS).toBe(SRC_STATUS);
    expect(PICK_ROLES).toBe(SRC_ROLES);
    for (const r of [...AD_ROLES, ...MOMENT_ROLES]) expect(ROLE_NAMES).toContain(r);
  });

  it('has a target for every bundled site with a video', () => {
    const dir = fileURLToPath(new URL('../../src/sites/', import.meta.url));
    const ids = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && playsVideo(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))))
      .map((f) => f.replace(/\.json$/, ''));
    const raw: unknown = JSON.parse(readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));
    const { targets, errors } = parseTargets(raw);
    expect(errors).toEqual([]);
    for (const id of ids) expect(Object.keys(targets)).toContain(id);
  });

  it('checks only sites with a video role', () => {
    expect(playsVideo({ roles: { video: ['video'], post: ['article'] } })).toBe(true);
    expect(playsVideo({ roles: { post: ['article'], postText: ['p'] } })).toBe(false);
    expect(playsVideo({ roles: { video: [] } })).toBe(false);
    expect(playsVideo(null)).toBe(false);
  });

  it('passes a healthy run; ads are seen / not seen, never failures', () => {
    const r = evaluateRun(good);
    expect(r.ok).toBe(true);
    expect(r.roles.map((x) => [x.role, x.verdict])).toEqual([
      ['video', 'pass'],
      ['playButton', 'pass'],
      ['title', 'pass'],
      ['adIndicator', 'not-seen'],
      ['skip', 'not-seen'],
    ]);
    expect(evaluateRun({ ...good, adSeen: true, skipSeen: true }).roles.slice(3).map((x) => x.verdict)).toEqual([
      'seen',
      'seen',
    ]);
  });

  it('warns on fallbacks and accepts present-but-hidden controls', () => {
    const r = evaluateRun({ ...good, roles: [role('video', 0), role('playButton', 1, [0, 1]), role('progressBar', null, [2])] });
    expect(r.ok).toBe(true);
    expect(r.roles[1]).toMatchObject({ verdict: 'fallback', matched: '.playButton-2' });
    expect(r.roles[2]).toMatchObject({ verdict: 'pass', detail: 'found, but not visible' });
  });

  it('never fails a prompt role that only shows in rare moments', () => {
    const r = evaluateRun({ ...good, roles: [role('video', 0), role('continuePrompt', null, [0])] });
    expect(r.ok).toBe(true);
    expect(r.roles[1]).toMatchObject({ verdict: 'not-seen' });
  });

  it('fails on missing roles, a heuristic-only video, no playback or no answer', () => {
    expect(evaluateRun({ ...good, roles: [role('title', null, [0])] }).problems).toEqual(['title: no selector matched']);
    expect(evaluateRun({ ...good, primarySource: 'heuristic' }).ok).toBe(false);
    expect(evaluateRun({ ...good, played: false }).ok).toBe(false);
    expect(evaluateRun({ ...good, roles: null }).problems).toContain('the extension didn’t answer in this tab');
  });

  it('writes a readable summary', () => {
    const md = summarize([evaluateRun(good), evaluateRun({ ...good, site: 'b.com', played: false })], '2026-11-06');
    expect(md).toContain('**1 of 2 site(s) failed.**');
    expect(md).toContain('## ✅ youtube.com');
    expect(md).toContain('| video | ✅ pass | `.video-1` |  |');
  });
});

describe('built-in playlist check', () => {
  const text = [
    '# name: Cat videos',
    '[shuffle]',
    '[ads]',
    '  10: Fun fact: cats sleep a lot',
    'https://www.youtube.com/watch?v=aaa | Cat | t=10',
    '  https://youtu.be/bbb',
    '# https://example.com/commented-out',
    '',
  ].join('\n');

  it('reads the same entries as the real parser', () => {
    const file = parseBuiltinFile('cats', text);
    expect(file).toEqual({
      id: 'cats',
      name: 'Cat videos',
      urls: ['https://www.youtube.com/watch?v=aaa', 'https://youtu.be/bbb'],
      views: ['video', 'video'],
    });
    expect(file.urls).toEqual(compilePlaylist(parsePlaylist(text)).entries.map((e) => e.url));
  });

  it('reads views like the real parser', () => {
    const mixed = [
      '# name: Mixed',
      '[view read]',
      'https://a.com/story',
      'https://x.com/a/status/1 | view=Card | dur=20',
      'https://www.youtube.com/watch?v=a | Title | view=video',
    ].join('\n');
    expect(parseBuiltinFile('mixed', mixed).views).toEqual(compilePlaylist(parsePlaylist(mixed)).entries.map((e) => e.view));
  });

  it('judges pages by their HTTP status, posts by their adapter', () => {
    expect(judgeHttp('u', 200, null)).toEqual({ url: 'u', verdict: 'ok', detail: null });
    expect(judgeHttp('u', 404, null).verdict).toBe('gone');
    expect(judgeHttp('u', 403, null).verdict).toBe('unknown');
    expect(judgeHttp('u', 500, null)).toEqual({ url: 'u', verdict: 'unknown', detail: 'HTTP 500' });
    expect(judgeHttp('u', null, 'timeout')).toEqual({ url: 'u', verdict: 'unknown', detail: 'timeout' });
    expect(judgePost('u', { ok: true }, null)).toEqual({ url: 'u', verdict: 'ok', detail: null });
    expect(judgePost('u', { ok: false, gone: true, error: 'deleted' }, null)).toEqual({ url: 'u', verdict: 'gone', detail: 'deleted' });
    expect(judgePost('u', { ok: false, gone: false, error: 'HTTP 429' }, null).verdict).toBe('unknown');
    expect(judgePost('u', null, null)).toEqual({ url: 'u', verdict: 'unknown', detail: 'not a post Wtv can read' });
    expect(judgePost('u', null, 'timeout').detail).toBe('timeout');
  });

  it('reads every shipped file the same way the extension does', () => {
    const dir = fileURLToPath(new URL('../../src/playlists/', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
      const t = readFileSync(dir + f, 'utf8');
      const compiled = compilePlaylist(parsePlaylist(t)).entries;
      expect(parseBuiltinFile(f, t).urls, f).toEqual(compiled.map((e) => e.url));
      expect(parseBuiltinFile(f, t).views, f).toEqual(compiled.map((e) => e.view));
    }
  });

  const seen: EntryObservation = { playlist: 'cats', url: 'https://www.youtube.com/watch?v=aaa', unavailableSeen: false, playability: { status: 'OK', reason: null }, error: null };

  it('judges entries by the player and YouTube’s own status', () => {
    expect(judgeEntry(seen).verdict).toBe('ok');
    expect(judgeEntry({ ...seen, unavailableSeen: true, playability: null })).toMatchObject({ verdict: 'gone' });
    expect(judgeEntry({ ...seen, playability: { status: 'ERROR', reason: 'Video unavailable' } })).toEqual({
      url: seen.url,
      verdict: 'gone',
      detail: 'ERROR: Video unavailable',
    });
    expect(judgeEntry({ ...seen, playability: { status: 'LOGIN_REQUIRED', reason: 'This video is private' } }).verdict).toBe('gone');
    expect(judgeEntry({ ...seen, playability: { status: 'AGE_CHECK_REQUIRED', reason: null } }).verdict).toBe('restricted');
    expect(judgeEntry({ ...seen, playability: null, error: 'timeout' }).verdict).toBe('unknown');
    expect(judgeEntry({ ...seen, playability: null }).verdict).toBe('ok');
  });

  it('lists gone entries per playlist', () => {
    const md = summarizePlaylists([
      { id: 'cats', name: 'Cat videos', entries: [judgeEntry(seen), judgeEntry({ ...seen, url: 'https://youtu.be/x', unavailableSeen: true })] },
      { id: 'art', name: 'Artwork', entries: [judgeEntry(seen)] },
    ]);
    expect(md).toContain('## ❌ 1 gone · Cat videos (cats) · 2 entries');
    expect(md).toContain('- ❌ gone: https://youtu.be/x (the player says it’s unavailable)');
    expect(md).toContain('## ✅ · Artwork (art) · 1 entries');
  });
});
