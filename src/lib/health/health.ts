/**
 * In-extension site health: notice when a site's selectors stop matching during normal
 * use. Pure. Local only, no telemetry.
 *
 * Content scripts check the **player roles** once per page, after the primary video has
 * played a while with no ad showing (so the page is fully built and it's clearly a
 * watch page). Metadata roles (title, creator, …) aren't judged: they legitimately
 * vary by page type (embeds, Shorts, live), and nothing depends on them yet. Ad roles
 * can't be judged in normal use at all: no ad isn't evidence of anything.
 *
 * A role is **broken** after failing on FAIL_STREAK separate pages in a row with no
 * success in between, so one odd page doesn't raise the alarm.
 */
import { isRecord } from '../sites/validate';
import type { RoleName } from '../sites/schema';

/** Roles whose absence on a page that's playing its video means something is wrong. */
export const PLAYER_ROLES = ['video', 'playButton', 'progressBar'] as const satisfies readonly RoleName[];
export type PlayerRole = (typeof PLAYER_ROLES)[number];

export const FAIL_STREAK = 2;

export const HEALTH_REPORT = 'wtv/health/report';

export interface RoleHealth {
  /** Consecutive failed checks. */
  failStreak: number;
  lastOk: number | null;
  lastFail: number | null;
}

export interface SiteHealth {
  roles: Partial<Record<PlayerRole, RoleHealth>>;
}

/** siteId → health. */
export type HealthStore = Record<string, SiteHealth>;

export interface HealthReport {
  type: typeof HEALTH_REPORT;
  siteId: string;
  /** Role → matched on this page. Only roles the site config defines. */
  results: Partial<Record<PlayerRole, boolean>>;
}

export function applyReport(store: HealthStore, report: Omit<HealthReport, 'type'>, now: number): HealthStore {
  const site: SiteHealth = { roles: { ...store[report.siteId]?.roles } };
  for (const role of PLAYER_ROLES) {
    const ok = report.results[role];
    if (ok === undefined) continue;
    const prev = site.roles[role] ?? { failStreak: 0, lastOk: null, lastFail: null };
    site.roles[role] = ok
      ? { failStreak: 0, lastOk: now, lastFail: prev.lastFail }
      : { failStreak: prev.failStreak + 1, lastOk: prev.lastOk, lastFail: now };
  }
  return { ...store, [report.siteId]: site };
}

export function brokenRoles(site: SiteHealth | undefined): PlayerRole[] {
  if (!site) return [];
  return PLAYER_ROLES.filter((r) => (site.roles[r]?.failStreak ?? 0) >= FAIL_STREAK);
}

/** Forget sites (their selectors changed: an override was saved, or a new release). */
export function withoutSites(store: HealthStore, siteIds: readonly string[]): HealthStore {
  const out = { ...store };
  for (const id of siteIds) delete out[id];
  return out;
}

export function parseHealthReport(raw: unknown): HealthReport | null {
  if (!isRecord(raw) || raw.type !== HEALTH_REPORT || typeof raw.siteId !== 'string' || !isRecord(raw.results)) {
    return null;
  }
  const results: HealthReport['results'] = {};
  for (const role of PLAYER_ROLES) {
    const v = raw.results[role];
    if (typeof v === 'boolean') results[role] = v;
  }
  return { type: HEALTH_REPORT, siteId: raw.siteId, results };
}

export function parseHealthStore(raw: unknown): HealthStore {
  if (!isRecord(raw)) return {};
  const out: HealthStore = {};
  for (const [siteId, site] of Object.entries(raw)) {
    if (!isRecord(site) || !isRecord(site.roles)) continue;
    const roles: SiteHealth['roles'] = {};
    for (const role of PLAYER_ROLES) {
      const r = site.roles[role];
      if (isRecord(r) && typeof r.failStreak === 'number') {
        roles[role] = {
          failStreak: r.failStreak,
          lastOk: typeof r.lastOk === 'number' ? r.lastOk : null,
          lastFail: typeof r.lastFail === 'number' ? r.lastFail : null,
        };
      }
    }
    out[siteId] = { roles };
  }
  return out;
}
