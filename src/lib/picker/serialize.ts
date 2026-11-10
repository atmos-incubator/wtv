/**
 * Site config → the JSON file format in src/sites/. Pure.
 * Matchers without a `when` are written as plain selector strings (the shorthand),
 * so files stay easy to hand-edit and diff.
 */
import { ROLE_NAMES, type SiteConfig } from '../sites/schema';

export function siteConfigToJson(config: SiteConfig): string {
  const roles: Record<string, (string | { selector: string; when: string })[]> = {};
  for (const role of ROLE_NAMES) {
    const matchers = config.roles[role];
    if (!matchers?.length) continue;
    roles[role] = matchers.map((m) => (m.when ? { selector: m.selector, when: m.when } : m.selector));
  }
  const file: Record<string, unknown> = {
    schemaVersion: config.schemaVersion,
    id: config.id,
    name: config.name,
    domains: config.domains,
  };
  if (config.access) file.access = config.access;
  file.roles = roles;
  if (config.thumbnailHosts?.length) file.thumbnailHosts = config.thumbnailHosts;
  if (config.quirks && Object.keys(config.quirks).length > 0) file.quirks = config.quirks;
  return `${JSON.stringify(file, null, 2)}\n`;
}
