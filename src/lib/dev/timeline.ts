/**
 * Dev builds only: a rolling timeline of what the overlay and the ad watcher did, for
 * rare glitches that can't be reproduced on demand. Every entry also goes to the console
 * (debug level, so "Verbose"); the 📸 snapshot saves the last MAX_ENTRIES.
 * In store builds every call is dropped (DEV_TOOLS folds to false).
 */
import { DEV_TOOLS } from '../env';

const MAX_ENTRIES = 3000;
const entries: string[] = [];

function format(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function record(source: string, ...parts: unknown[]): void {
  if (!DEV_TOOLS) return;
  const line = `+${Math.round(performance.now())}ms ${source}: ${parts.map(format).join(' ')}`;
  entries.push(line);
  if (entries.length > MAX_ENTRIES) entries.shift();
  console.debug(`[wtv] ${line}`);
}

export function timeline(): string[] {
  return [...entries];
}
