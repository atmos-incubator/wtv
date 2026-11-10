/**
 * LAN builds: which build a folder holds. `build.json` is written into the output folder when a
 * LAN build finishes (wxt.config.ts), and the same id is baked into the code. The LAN server
 * (scripts/lan/serve.ts) serves it, the Windows sync script copies it last, and the running
 * extension compares it with its own (src/lib/lan/updates.ts).
 *
 * Pure, and free of imports: the Node scripts load this file directly.
 */

export const BUILD_FILE = 'build.json';

export interface BuildInfo {
  /** Unique per build, e.g. `2.0.0+20261109-142233-a1b2`. */
  id: string;
  /** The manifest version. */
  version: string;
  /** ISO time the build finished. */
  builtAt: string;
}

const ID = /^[\w.+-]{1,80}$/;

export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { id, version, builtAt } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof version !== 'string' || typeof builtAt !== 'string') return null;
  return { id, version, builtAt };
}

/** A new build id: version, then the time, then a little randomness. */
export function newBuildId(version: string, now: Date, random: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const tail = Math.floor(random * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${version.replace(/[^\w.-]/g, '')}+${time}-${tail}`;
}

/** The reload already tried for this disk build while running this one (it didn't take). */
export interface ReloadTried {
  running: string;
  disk: string;
}

/**
 * Reload to pick up the build on disk? Only when it's another build than the one running,
 * and not one a reload already failed to pick up (that would reload forever). Pure.
 */
export function shouldReload(running: string, disk: BuildInfo | null, tried: ReloadTried | null): boolean {
  if (!disk || disk.id === running) return false;
  return !(tried && tried.running === running && tried.disk === disk.id);
}
