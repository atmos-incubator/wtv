/** Pure helpers for host permissions and match patterns. */

const WEB_PATTERN = /^(\*|https?):\/\/[^/]+\/.*$/;

/** Keep only http(s) match patterns (drops e.g. chrome-extension:// or file:// entries). */
export function webMatchPatterns(origins: readonly string[]): string[] {
  return [...new Set(origins.filter((o) => WEB_PATTERN.test(o)))].sort();
}

/** The optional-permission pattern requested when a user enables Wtv on a host. */
export function originPatternForHost(host: string): string {
  return `*://${host.toLowerCase()}/*`;
}

export function isWebUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}
