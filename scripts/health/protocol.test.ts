import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MSG_STATUS as SRC_STATUS } from '../../src/lib/messages';
import { PICK_ROLES as SRC_ROLES } from '../../src/lib/picker/messages';
import { ROLE_NAMES } from '../../src/lib/sites/schema';
import { AD_ROLES, MSG_STATUS, PICK_ROLES, evaluateRun, parseTargets, summarize, type Observation, type RoleLite } from './protocol';

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
    for (const r of AD_ROLES) expect(ROLE_NAMES).toContain(r);
  });

  it('has a target for every bundled site', () => {
    const dir = fileURLToPath(new URL('../../src/sites/', import.meta.url));
    const ids = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
    const raw: unknown = JSON.parse(readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));
    const { targets, errors } = parseTargets(raw);
    expect(errors).toEqual([]);
    for (const id of ids) expect(Object.keys(targets)).toContain(id);
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
