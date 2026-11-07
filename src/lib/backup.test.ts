import { describe, expect, it } from 'vitest';
import { backupFileName, describePlan, makeBackup, parseBackup, planChangesAnything, planImport, type WtvState } from './backup';
import { DEFAULT_SETTINGS } from './settings';
import type { OverrideStore } from './sites/overrides';

const pl = (id: string, name: string, text = 'https://a.com/1\n') => ({ id, name, text, createdAt: 1, updatedAt: 2 });
const override = (selector: string): OverrideStore[string]['roles']['title'] => ({
  matchers: [{ selector }],
  baseHash: 'abc',
  savedAt: 5,
});

const state: WtvState = {
  playlists: { 'pl-1': pl('pl-1', 'Mine'), 'pl-2': pl('pl-2', 'Shared') },
  overrides: { 'youtube.com': { roles: { title: override('h1.mine'), creator: override('.me') } } },
  settings: { ...DEFAULT_SETTINGS },
};

describe('backup', () => {
  it('round-trips through JSON', () => {
    const backup = makeBackup(state, new Date('2026-11-07T12:00:00Z'));
    const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
    expect(parsed).toEqual({ ok: true, backup, warnings: [] });
    expect(backup.playlists.map((p) => p.name)).toEqual(['Mine', 'Shared']);
    expect(backupFileName(new Date('2026-11-07T12:00:00Z'))).toBe('wtv-backup-2026-11-07.json');
  });

  it('rejects other files and other versions', () => {
    expect(parseBackup({ playlists: [] })).toEqual({ ok: false, error: 'This isn’t a Wtv backup file.' });
    expect(parseBackup('nope').ok).toBe(false);
    expect(parseBackup({ format: 'wtv-backup', version: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/version 2/) });
  });

  it('drops malformed, built-in and duplicate playlists, bad selectors and bad settings with warnings', () => {
    const parsed = parseBackup({
      format: 'wtv-backup',
      version: 1,
      playlists: [pl('pl-9', '  New   one '), { id: 'pl-x', name: 3 }, pl('builtin-cats', 'Cats'), pl('pl-9', 'Again')],
      overrides: { 'not a host': { roles: {} }, 'youtube.com': { roles: { title: { matchers: 'x', baseHash: 'a', savedAt: 1 } } } },
      settings: { muteAds: false, autoSkip: 'yes' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.playlists).toEqual([pl('pl-9', 'New one')]);
    expect(parsed.backup.overrides).toEqual({});
    expect(parsed.backup.settings).toEqual({ ...DEFAULT_SETTINGS, muteAds: false });
    expect(parsed.warnings).toEqual([
      'Playlist #2: malformed, skipped.',
      '“Cats”: a built-in playlist, skipped.',
      '“Again”: listed twice, the second copy skipped.',
      expect.stringMatching(/^Selector overrides: invalid site id/),
      expect.stringMatching(/^Selector /),
      expect.stringMatching(/^Selector /),
    ]);
  });
});

describe('planImport', () => {
  it('merges playlists by id, overrides by role, and replaces settings', () => {
    const backup = makeBackup({
      playlists: { 'pl-2': pl('pl-2', 'Shared', 'https://b.com/2\n'), 'pl-3': pl('pl-3', 'Theirs'), 'pl-1': pl('pl-1', 'Mine') },
      overrides: { 'youtube.com': { roles: { title: override('h1.theirs') } }, 'vimeo.com': { roles: { title: override('h1') } } },
      settings: { ...DEFAULT_SETTINGS, pausePictures: true },
    });
    const plan = planImport(state, backup);
    expect(plan.added).toEqual(['Theirs']);
    expect(plan.replaced).toEqual(['Shared']);
    expect(plan.unchanged).toBe(1);
    expect(plan.settingsChanged).toBe(true);
    expect(Object.keys(plan.next.playlists).sort()).toEqual(['pl-1', 'pl-2', 'pl-3']);
    expect(plan.next.playlists['pl-2']!.text).toBe('https://b.com/2\n');
    expect(plan.next.overrides['youtube.com']!.roles).toEqual({ title: override('h1.theirs'), creator: override('.me') });
    expect(plan.next.overrides['vimeo.com']).toBeDefined();
    expect(plan.next.settings.pausePictures).toBe(true);
    expect(describePlan(plan)).toBe(
      [
        'Add 1 playlist(s): “Theirs”',
        'Replace 1 playlist(s) with the backup’s copy: “Shared”',
        '1 playlist(s) already match the backup.',
        'Use the backup’s selectors for youtube.com: title; vimeo.com: title',
        'Replace your settings with the backup’s.',
      ].join('\n'),
    );
    // The current state isn't touched.
    expect(state.overrides['youtube.com']!.roles.title).toEqual(override('h1.mine'));
  });

  it('says when nothing would change', () => {
    const plan = planImport(state, makeBackup({ playlists: {}, overrides: {}, settings: state.settings }));
    expect(planChangesAnything(plan)).toBe(false);
    expect(describePlan(plan)).toBe('Nothing to change: everything already matches the backup.');
  });
});
