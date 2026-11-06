/**
 * Image file names: `<name>[_d<N>[s|m]].<ext>`.
 *   grumpy_cats_d10s.png → stem "grumpy_cats", 10 s
 *   relax_d2m.webm       → stem "relax", 2 min
 *   cat.jpg              → stem "cat", default duration
 */

export type MediaKind = 'image' | 'video';

const EXTENSIONS: Record<string, { kind: MediaKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  gif: { kind: 'image', mime: 'image/gif' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  webm: { kind: 'video', mime: 'video/webm' },
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSIONS);

export interface ParsedFilename {
  /** Lowercase name without extension or duration suffix. Used for keyword matching. */
  stem: string;
  durationMs: number | null;
  kind: MediaKind;
  mime: string;
}

const DURATION_SUFFIX = /_d(\d+)(s|m)?$/i;

/** Returns null for hidden files and unsupported extensions. */
export function parseImageFilename(name: string): ParsedFilename | null {
  if (name.startsWith('.')) return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const type = EXTENSIONS[name.slice(dot + 1).toLowerCase()];
  if (!type) return null;

  let stem = name.slice(0, dot);
  let durationMs: number | null = null;
  const d = DURATION_SUFFIX.exec(stem);
  if (d) {
    const n = Number(d[1]);
    if (n > 0) durationMs = n * (d[2]?.toLowerCase() === 'm' ? 60_000 : 1000);
    stem = stem.slice(0, d.index);
  }
  if (!stem) return null;
  return { stem: stem.toLowerCase(), durationMs, kind: type.kind, mime: type.mime };
}
