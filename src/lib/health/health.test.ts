import { describe, expect, it } from 'vitest';
import {
  FAIL_STREAK,
  HEALTH_REPORT,
  applyReport,
  brokenRoles,
  parseHealthReport,
  parseHealthStore,
  withoutSites,
  type HealthStore,
} from './health';

const fail = { siteId: 'youtube.com', results: { video: true, playButton: false } };
const ok = { siteId: 'youtube.com', results: { video: true, playButton: true } };

describe('site health', () => {
  it('flags a role only after failing on several pages in a row', () => {
    let store: HealthStore = {};
    for (let i = 1; i < FAIL_STREAK; i++) store = applyReport(store, fail, i);
    expect(brokenRoles(store['youtube.com'])).toEqual([]);
    store = applyReport(store, fail, 10);
    expect(brokenRoles(store['youtube.com'])).toEqual(['playButton']);
    expect(store['youtube.com']!.roles.playButton).toEqual({ failStreak: FAIL_STREAK, lastOk: null, lastFail: 10 });
  });

  it('clears on the next success', () => {
    let store: HealthStore = {};
    for (let i = 0; i < FAIL_STREAK; i++) store = applyReport(store, fail, i);
    store = applyReport(store, ok, 20);
    expect(brokenRoles(store['youtube.com'])).toEqual([]);
    expect(store['youtube.com']!.roles.playButton).toMatchObject({ failStreak: 0, lastOk: 20 });
  });

  it('leaves roles that were not checked alone, and forgets sites', () => {
    let store = applyReport({}, fail, 1);
    store = applyReport(store, { siteId: 'youtube.com', results: { video: true } }, 2);
    expect(store['youtube.com']!.roles.playButton?.failStreak).toBe(1);
    expect(withoutSites(store, ['youtube.com'])).toEqual({});
    expect(brokenRoles(undefined)).toEqual([]);
  });

  it('parses reports and stored data defensively', () => {
    expect(parseHealthReport({ type: HEALTH_REPORT, siteId: 'a.com', results: { video: false, title: true, x: 1 } })).toEqual(
      { type: HEALTH_REPORT, siteId: 'a.com', results: { video: false } },
    );
    expect(parseHealthReport({ type: HEALTH_REPORT, siteId: 'a.com' })).toBeNull();
    expect(parseHealthStore({ 'a.com': { roles: { video: { failStreak: 2 }, title: { failStreak: 9 } } }, b: 3 })).toEqual({
      'a.com': { roles: { video: { failStreak: 2, lastOk: null, lastFail: null } } },
    });
  });
});
