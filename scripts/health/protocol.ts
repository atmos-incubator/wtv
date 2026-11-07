/**
 * Site health check: what the runner observes, and how that becomes pass / fail. Pure.
 *
 * Self-contained on purpose: run.ts runs under Node's type stripping, which can't
 * resolve the extension's extension-less imports. protocol.test.ts keeps the duplicated
 * constants in sync with src/.
 */

/** Extension messages the runner sends a tab (see src/lib/messages.ts, src/lib/picker/messages.ts). */
export const MSG_STATUS = 'wtv/status';
export const PICK_ROLES = 'wtv/pick/roles';

/** Only present during ads, which aren't guaranteed: recorded as seen / not seen, never failed. */
export const AD_ROLES: readonly string[] = ['adIndicator', 'skip'];
/** Roles that only exist in rare moments (a "still watching?" dialog): reported, never judged. */
export const MOMENT_ROLES: readonly string[] = ['continuePrompt'];

export interface Target {
  url: string;
  note?: string;
}

/** A role as the extension's PICK_ROLES report describes it. */
export interface RoleLite {
  role: string;
  matchers: { selector: string; count: number; satisfied: boolean; error: string | null }[];
  matchedIndex: number | null;
}

export interface Observation {
  site: string;
  url: string;
  finalUrl: string | null;
  /** The primary played (ad-free) for the settle period. */
  played: boolean;
  /** Whether the site config's video role picked the playing primary, at the final check. */
  primarySource: 'config' | 'heuristic' | null;
  /** The final role report from the top frame; null if the extension never answered. */
  roles: RoleLite[] | null;
  adSeen: boolean;
  skipSeen: boolean;
  error: string | null;
}

export type Verdict = 'pass' | 'fallback' | 'fail' | 'seen' | 'not-seen';

export interface RoleResult {
  role: string;
  verdict: Verdict;
  /** The selector that matched, if any. */
  matched: string | null;
  detail: string | null;
}

export interface SiteResult {
  site: string;
  url: string;
  ok: boolean;
  played: boolean;
  adSeen: boolean;
  roles: RoleResult[];
  problems: string[];
}

function judgeRole(o: Observation, r: RoleLite): RoleResult {
  const matched = r.matchedIndex !== null ? (r.matchers[r.matchedIndex]?.selector ?? null) : null;
  const errors = r.matchers.map((m) => m.error).filter((e): e is string => Boolean(e));
  const errorNote = errors.length > 0 ? errors.join('; ') : null;

  if (r.role === 'adIndicator') return { role: r.role, verdict: o.adSeen ? 'seen' : 'not-seen', matched, detail: null };
  if (r.role === 'skip') return { role: r.role, verdict: o.skipSeen ? 'seen' : 'not-seen', matched, detail: null };
  if (MOMENT_ROLES.includes(r.role)) {
    return { role: r.role, verdict: r.matchedIndex !== null ? 'seen' : 'not-seen', matched, detail: null };
  }

  if (r.role === 'video' && o.primarySource !== 'config') {
    return { role: r.role, verdict: 'fail', matched, detail: errorNote ?? 'its selectors didn’t pick the playing video' };
  }
  if (r.matchedIndex === null) {
    // Present but hidden (players fade controls out while playing) still counts.
    const present = r.matchers.find((m) => m.count > 0);
    if (present) return { role: r.role, verdict: 'pass', matched: present.selector, detail: 'found, but not visible' };
    return { role: r.role, verdict: 'fail', matched: null, detail: errorNote ?? 'no selector matched' };
  }
  if (r.matchedIndex > 0) {
    return {
      role: r.role,
      verdict: 'fallback',
      matched,
      detail: `selector #1 (${r.matchers[0]?.selector ?? '?'}) no longer matches; fallback #${r.matchedIndex + 1} did`,
    };
  }
  return { role: r.role, verdict: 'pass', matched, detail: errorNote };
}

export function evaluateRun(o: Observation): SiteResult {
  const problems: string[] = [];
  if (o.error) problems.push(o.error);
  if (!o.played) problems.push('no video played (ad-free) within the time limit');
  if (!o.roles) problems.push('the extension didn’t answer in this tab');

  const roles = (o.roles ?? []).filter((r) => r.matchers.length > 0).map((r) => judgeRole(o, r));
  for (const r of roles) if (r.verdict === 'fail') problems.push(`${r.role}: ${r.detail ?? 'failed'}`);

  return { site: o.site, url: o.url, ok: problems.length === 0, played: o.played, adSeen: o.adSeen, roles, problems };
}

const ICON: Record<Verdict, string> = { pass: '✅', fallback: '⚠️', fail: '❌', seen: '👁', 'not-seen': '·' };

/** Markdown report. */
export function summarize(results: readonly SiteResult[], startedAt: string): string {
  const failed = results.filter((r) => !r.ok).length;
  const lines = [
    `# Wtv site health — ${startedAt}`,
    '',
    failed === 0 ? `All ${results.length} site(s) passed.` : `**${failed} of ${results.length} site(s) failed.**`,
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.ok ? '✅' : '❌'} ${r.site}`, '', r.url, '');
    for (const p of r.problems) lines.push(`- ${p}`);
    if (r.problems.length > 0) lines.push('');
    if (r.roles.length > 0) {
      lines.push('| Role | Result | Selector | Note |', '| --- | --- | --- | --- |');
      for (const role of r.roles) {
        const sel = role.matched ? `\`${role.matched.replace(/\|/g, '\\|')}\`` : '';
        lines.push(`| ${role.role} | ${ICON[role.verdict]} ${role.verdict} | ${sel} | ${role.detail ?? ''} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function parseTargets(raw: unknown): { targets: Record<string, Target>; errors: string[] } {
  const targets: Record<string, Target> = {};
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { targets, errors: ['not an object'] };
  for (const [site, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as { url?: unknown; note?: unknown } | null;
    if (typeof v?.url !== 'string' || !/^https?:\/\//.test(v.url)) {
      errors.push(`${site}: needs a "url"`);
      continue;
    }
    targets[site] = { url: v.url, ...(typeof v.note === 'string' ? { note: v.note } : {}) };
  }
  return { targets, errors };
}
