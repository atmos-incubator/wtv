import { describe, expect, it } from 'vitest';
import { siteConfigToJson } from '../picker/serialize';
import { makeRoleOverride, type OverrideStore } from './overrides';
import type { SiteConfig } from './schema';
import {
  makeSelectorsFile,
  parseSelectorsFile,
  planRepoWrite,
  planSelectorsImport,
  selectorsFileName,
} from './selectors-file';

const yt: SiteConfig = {
  schemaVersion: 1,
  id: 'youtube.com',
  name: 'YouTube',
  domains: ['youtube.com'],
  roles: { video: [{ selector: 'video.main' }], skip: [{ selector: '.skip' }] },
};
const ytChanged: SiteConfig = { ...yt, roles: { ...yt.roles, skip: [{ selector: '.skip-2' }] } };

const store: OverrideStore = {
  'youtube.com': {
    roles: {
      skip: makeRoleOverride(yt, 'skip', [{ selector: '.my-skip' }, { selector: '.skip' }], 1),
      title: makeRoleOverride(yt, 'title', [{ selector: 'h1.title' }], 1),
    },
    quirks: { startsItself: true },
  },
  'bsky.app': {
    name: 'Bluesky',
    domains: ['bsky.app'],
    roles: { postText: makeRoleOverride(undefined, 'postText', [{ selector: '[data-testid=postText]' }], 1) },
  },
};

describe('selectors file', () => {
  it('round-trips the store', () => {
    const file = makeSelectorsFile(store, new Date('2026-11-10T12:00:00Z'));
    expect(Object.keys(file.sites)).toEqual(['bsky.app', 'youtube.com']);
    const parsed = parseSelectorsFile(JSON.parse(JSON.stringify(file)));
    expect(parsed).toEqual({ ok: true, sites: store, warnings: [] });
    expect(selectorsFileName(new Date('2026-11-10T12:00:00Z'))).toBe('wtv-selectors-2026-11-10.json');
  });

  it('reads the selectors of a full backup', () => {
    const parsed = parseSelectorsFile({ format: 'wtv-backup', version: 1, overrides: store, playlists: [] });
    expect(parsed.ok && parsed.sites).toEqual(store);
  });

  it('refuses other files, and drops what is malformed', () => {
    expect(parseSelectorsFile({ format: 'nope' }).ok).toBe(false);
    expect(parseSelectorsFile({ format: 'wtv-selectors', version: 2, sites: {} }).ok).toBe(false);
    const parsed = parseSelectorsFile({
      format: 'wtv-selectors',
      version: 1,
      sites: { 'youtube.com': { roles: { skip: { matchers: 'x', baseHash: 'none', savedAt: 1 } } } },
    });
    expect(parsed.ok && parsed.sites).toEqual({});
    expect(parsed.ok && parsed.warnings.length).toBeGreaterThan(0);
  });
});

describe('planSelectorsImport', () => {
  it('adds everything to an empty store', () => {
    const plan = planSelectorsImport({}, store, [yt]);
    expect(plan.next).toEqual(store);
    expect(plan.changes).toEqual([
      'bsky.app: domains bsky.app, postText (new)',
      'youtube.com: skip (new), title (new), startsItself on',
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('counts what already matches, and keeps roles the file lacks', () => {
    const current: OverrideStore = {
      'youtube.com': { roles: { skip: store['youtube.com']!.roles.skip!, video: makeRoleOverride(yt, 'video', [{ selector: 'video' }], 1) } },
    };
    const plan = planSelectorsImport(current, { 'youtube.com': store['youtube.com']! }, [yt]);
    expect(plan.unchanged).toBe(1);
    expect(plan.changes).toEqual(['youtube.com: title (new), startsItself on']);
    expect(Object.keys(plan.next['youtube.com']!.roles).sort()).toEqual(['skip', 'title', 'video']);
  });

  it('skips roles saved over other built-in selectors', () => {
    const plan = planSelectorsImport({}, { 'youtube.com': store['youtube.com']! }, [ytChanged]);
    expect(plan.skipped).toEqual(['youtube.com skip: saved over other built-in selectors than this Wtv has, so it wouldn’t apply.']);
    expect(Object.keys(plan.next['youtube.com']!.roles)).toEqual(['title']);
  });

  it('skips unknown sites with no domains', () => {
    const plan = planSelectorsImport({}, { 'x.com': { roles: store['bsky.app']!.roles } }, [yt]);
    expect(plan.next).toEqual({});
    expect(plan.skipped).toHaveLength(1);
  });

  it('has nothing to do when everything matches', () => {
    const plan = planSelectorsImport(store, store, [yt]);
    expect(plan.changes).toEqual([]);
    expect(plan.next).toEqual(store);
  });
});

describe('planRepoWrite', () => {
  const repo = { 'youtube.com.json': siteConfigToJson(yt) };

  it('layers the file over the repo’s site files', () => {
    const plan = planRepoWrite(store, repo);
    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.writes.map((w) => [w.file, w.roles, w.quirks, w.isNew])).toEqual([
      ['bsky.app.json', ['postText'], [], true],
      ['youtube.com.json', ['skip', 'title'], ['startsItself'], false],
    ]);
    const written = JSON.parse(plan.writes[1]!.text);
    expect(written.roles.skip).toEqual(['.my-skip', '.skip']);
    expect(written.roles.title).toEqual(['h1.title']);
    expect(written.roles.video).toEqual(['video.main']);
    expect(written.quirks).toEqual({ startsItself: true });
    expect(JSON.parse(plan.writes[0]!.text)).toMatchObject({ id: 'bsky.app', name: 'Bluesky', domains: ['bsky.app'], access: 'optional' });
    expect(JSON.parse(plan.writes[1]!.text)).not.toHaveProperty('access');
  });

  it('skips roles the repo changed since, and what is already there', () => {
    const plan = planRepoWrite({ 'youtube.com': store['youtube.com']! }, { 'youtube.com.json': siteConfigToJson(ytChanged) });
    expect(plan.skipped).toEqual(['youtube.com skip: the repo’s selectors changed since this was saved; redo it on the page.']);
    expect(plan.writes[0]!.roles).toEqual(['title']);

    const again = planRepoWrite(store, Object.fromEntries(planRepoWrite(store, repo).writes.map((w) => [w.file, w.text])));
    expect(again.writes).toEqual([]);
    expect(again.skipped).toEqual(['bsky.app: already in the repo.', 'youtube.com: already in the repo.']);
  });

  it('drops switches that are off', () => {
    const withAds: SiteConfig = { ...yt, quirks: { noAds: true } };
    const plan = planRepoWrite({ 'youtube.com': { roles: {}, quirks: { noAds: false } } }, { 'youtube.com.json': siteConfigToJson(withAds) });
    expect(JSON.parse(plan.writes[0]!.text).quirks).toBeUndefined();
  });

  it('writes nothing when the build would fail', () => {
    const clash: OverrideStore = { 'yt.example': { name: 'Clash', domains: ['youtube.com'], roles: store['bsky.app']!.roles } };
    const plan = planRepoWrite(clash, repo);
    expect(plan.writes).toEqual([]);
    expect(plan.errors.join()).toMatch(/already claimed/);
  });

  it('leaves a repo file that does not load alone', () => {
    const plan = planRepoWrite({ 'youtube.com': store['youtube.com']! }, { 'youtube.com.json': '{' });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual(['youtube.com: the repo’s youtube.com.json doesn’t load; fix it first.']);
  });
});
