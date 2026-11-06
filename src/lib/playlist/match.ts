/** URL helpers for the playlist runner. Pure. */
import { originPatternForHost } from '../permissions';

function normalHost(host: string): string {
  return host.toLowerCase().replace(/^(www|m)\./, '');
}

function normalPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Whether the tab's URL is still showing `expected`: same host (ignoring www. / m.),
 * same path, and every query parameter of `expected` present with the same value. Extra
 * parameters (tracking, `&t=`, `&pp=`) and the hash don't matter.
 */
export function sameEntryUrl(actual: string, expected: string): boolean {
  let a: URL;
  let e: URL;
  try {
    a = new URL(actual);
    e = new URL(expected);
  } catch {
    return false;
  }
  if (normalHost(a.hostname) !== normalHost(e.hostname)) return false;
  if (normalPath(a.pathname) !== normalPath(e.pathname)) return false;
  for (const [key, value] of e.searchParams) if (a.searchParams.get(key) !== value) return false;
  return true;
}

/** Host-permission patterns covering every entry, deduplicated. */
export function originPatternsFor(urls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const url of urls) {
    try {
      out.add(originPatternForHost(new URL(url).hostname));
    } catch {
      // Not a URL; the format already reported it.
    }
  }
  return [...out].sort();
}
