/**
 * Timestamps for `t=` (playlist entries, and later the `#wtv:` hash). Pure.
 *
 *   200   200s   1:37   1:02:03   1h2m3s   2m   1.5
 */

const PLAIN = /^(\d+(?:\.\d+)?)s?$/;
const CLOCK = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/;
const UNITS = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;

/** Seconds, or null if `text` isn't a timestamp. */
export function parseTimestamp(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;

  let m = PLAIN.exec(s);
  if (m) return Number(m[1]);

  m = CLOCK.exec(s);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }

  m = UNITS.exec(s);
  if (m && (m[1] || m[2] || m[3])) {
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return null;
}
