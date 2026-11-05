import {
  CONDITIONS,
  ROLE_NAMES,
  SCHEMA_VERSION,
  SHADOW_PIERCE,
  type Condition,
  type Matcher,
  type RoleName,
  type Roles,
  type SiteConfig,
  type SiteQuirks,
} from './schema';

export type ValidationResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'id', 'name', 'domains', 'roles', 'quirks']);

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lowercase hostname with at least one dot. No scheme, port, path or wildcard. */
export function isHostname(v: unknown): v is string {
  return typeof v === 'string' && HOSTNAME.test(v);
}

export function isRoleName(v: unknown): v is RoleName {
  return typeof v === 'string' && (ROLE_NAMES as readonly string[]).includes(v);
}

function isCondition(v: unknown): v is Condition {
  return typeof v === 'string' && (CONDITIONS as readonly string[]).includes(v);
}

/**
 * Structural check only. Real CSS validity is checked where a DOM exists
 * (content script / picker), since the service worker and tests have no querySelector.
 */
export function validateSelector(selector: unknown, path: string, errors: string[]): selector is string {
  if (typeof selector !== 'string' || selector.trim() === '') {
    errors.push(`${path}: selector must be a non-empty string`);
    return false;
  }
  if (selector.split(SHADOW_PIERCE).some((s) => s.trim() === '')) {
    errors.push(`${path}: empty segment around "${SHADOW_PIERCE}" in "${selector}"`);
    return false;
  }
  return true;
}

/**
 * Accepts shorthand strings or `{ selector, when }` objects and normalizes to Matcher[].
 * Duplicates are dropped with a warning.
 */
export function validateMatchers(
  raw: unknown,
  path: string,
  errors: string[],
  warnings: string[],
): Matcher[] {
  if (!Array.isArray(raw)) {
    errors.push(`${path}: must be an array of selectors`);
    return [];
  }
  const out: Matcher[] = [];
  const seen = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    const p = `${path}[${i}]`;
    let selector: unknown;
    let when: unknown;
    if (typeof entry === 'string') {
      selector = entry;
    } else if (isRecord(entry)) {
      selector = entry.selector;
      when = entry.when;
      for (const key of Object.keys(entry)) {
        if (key !== 'selector' && key !== 'when') warnings.push(`${p}: unknown key "${key}" ignored`);
      }
    } else {
      errors.push(`${p}: must be a selector string or { "selector", "when" } object`);
      return;
    }
    if (!validateSelector(selector, p, errors)) return;
    let condition: Condition | undefined;
    if (when !== undefined) {
      if (!isCondition(when)) {
        errors.push(`${p}: "when" must be one of ${CONDITIONS.join(', ')}`);
        return;
      }
      condition = when;
    }
    const sel = selector.trim();
    if (seen.has(sel)) {
      warnings.push(`${p}: duplicate selector "${sel}" dropped`);
      return;
    }
    seen.add(sel);
    out.push(condition === undefined ? { selector: sel } : { selector: sel, when: condition });
  });
  return out;
}

function validateQuirks(raw: unknown, errors: string[], warnings: string[]): SiteQuirks | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push('quirks: must be an object');
    return undefined;
  }
  const quirks: SiteQuirks = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'controlBarInset') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push('quirks.controlBarInset: must be a non-negative number of pixels');
      } else {
        quirks.controlBarInset = value;
      }
    } else {
      warnings.push(`quirks: unknown key "${key}" ignored`);
    }
  }
  return quirks;
}

/**
 * Validate a bundled site config. Strict: unknown roles are errors so typos in shipped
 * configs fail the build and tests rather than silently doing nothing.
 */
export function validateSiteConfig(raw: unknown, expectedId?: string): ValidationResult<SiteConfig> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) return { ok: false, errors: ['config must be a JSON object'], warnings };

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown top-level key "${key}" ignored`);
  }

  if (raw.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }

  const id = raw.id;
  if (!isHostname(id)) {
    errors.push('id: must be a lowercase domain, e.g. "youtube.com"');
  } else if (expectedId !== undefined && id !== expectedId) {
    errors.push(`id: "${id}" does not match file name "${expectedId}"`);
  }

  const name = raw.name;
  if (typeof name !== 'string' || name.trim() === '') errors.push('name: must be a non-empty string');

  const domains: string[] = [];
  if (!Array.isArray(raw.domains) || raw.domains.length === 0) {
    errors.push('domains: must be a non-empty array of hostnames');
  } else {
    raw.domains.forEach((d: unknown, i) => {
      if (!isHostname(d)) errors.push(`domains[${i}]: "${String(d)}" is not a lowercase hostname`);
      else if (domains.includes(d)) errors.push(`domains[${i}]: duplicate "${d}"`);
      else domains.push(d);
    });
  }

  const roles: Roles = {};
  if (!isRecord(raw.roles)) {
    errors.push('roles: must be an object');
  } else {
    for (const [role, value] of Object.entries(raw.roles)) {
      if (!isRoleName(role)) {
        errors.push(`roles.${role}: unknown role (expected one of ${ROLE_NAMES.join(', ')})`);
        continue;
      }
      const matchers = validateMatchers(value, `roles.${role}`, errors, warnings);
      if (matchers.length === 0) warnings.push(`roles.${role}: no selectors, role ignored`);
      else roles[role] = matchers;
    }
  }

  const quirks = validateQuirks(raw.quirks, errors, warnings);

  if (errors.length > 0) return { ok: false, errors, warnings };

  const value: SiteConfig = {
    schemaVersion: SCHEMA_VERSION,
    id: id as string,
    name: (name as string).trim(),
    domains,
    roles,
  };
  if (quirks && Object.keys(quirks).length > 0) value.quirks = quirks;
  return { ok: true, value, warnings };
}
