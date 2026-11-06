/**
 * Image library rules (pure). See todo.md "Image folder layout" / "[img ...] resolution".
 *
 *   images/                  ← picked root
 *     relax.png              ← top level (domain null, folder null)
 *     cats/                  ← top-level keyword folder (domain null, folder "cats")
 *     youtube.com/           ← domain folder (name contains a dot)
 *       grumpy_cats_d10s.png ← (domain "youtube.com", folder null)
 *       cats/                ← domain keyword folder (domain "youtube.com", folder "cats")
 *         deeper/            ← too deep: skipped
 */
import { domainMatches } from '../sites/match';
import { isHostname } from '../sites/validate';
import type { MediaKind } from './filename';

export interface ImageMeta {
  /** Path relative to the picked root, e.g. "youtube.com/cats/grumpy_d10s.png". */
  id: string;
  domain: string | null;
  /** Keyword folder name, lowercase. */
  folder: string | null;
  /** Lowercase file name without extension or duration suffix. */
  stem: string;
  durationMs: number | null;
  kind: MediaKind;
  mime: string;
}

export type PathPlacement = { domain: string | null; folder: string | null } | null;

export function isDomainFolder(name: string): boolean {
  return isHostname(name.toLowerCase());
}

/**
 * Where a file at `dirs` (directory names from the root) belongs, or null if it's too
 * deep. Keyword folders are one level deep only.
 */
export function classifyPath(dirs: readonly string[]): PathPlacement {
  const [first, second] = dirs;
  if (first === undefined) return { domain: null, folder: null };
  if (dirs.length === 1) {
    return isDomainFolder(first)
      ? { domain: first.toLowerCase(), folder: null }
      : { domain: null, folder: first.toLowerCase() };
  }
  if (dirs.length === 2 && second !== undefined && isDomainFolder(first) && !isDomainFolder(second)) {
    return { domain: first.toLowerCase(), folder: second.toLowerCase() };
  }
  return null;
}

/** The most specific domain folder matching `host`, if any. */
export function domainFolderFor(host: string, library: readonly Pick<ImageMeta, 'domain'>[]): string | null {
  let best: string | null = null;
  for (const { domain } of library) {
    if (domain && (best === null || domain.length > best.length) && domainMatches(host, domain)) best = domain;
  }
  return best;
}

type Matchable = Pick<ImageMeta, 'domain' | 'folder' | 'stem'>;

/**
 * Images for `[img]` (keyword null) or `[img <keyword>]` on `host`. First non-empty
 * step wins. An empty result means "use the bundled pack".
 *
 * With a keyword:
 *   1. <domain>/<keyword>/ folder
 *   2. <domain>/ top-level files with the keyword in the name
 *   3. <keyword>/ top-level folder
 *   4. top-level files with the keyword in the name
 * Without:
 *   1. <domain>/ top-level files
 *   2. top-level files
 */
export function resolveImages<T extends Matchable>(library: readonly T[], host: string, keyword: string | null): T[] {
  const domain = domainFolderFor(host, library);
  const k = keyword?.trim().toLowerCase() || null;

  const steps: ((m: T) => boolean)[] = [];
  if (k) {
    if (domain) {
      steps.push((m) => m.domain === domain && m.folder === k);
      steps.push((m) => m.domain === domain && m.folder === null && m.stem.includes(k));
    }
    steps.push((m) => m.domain === null && m.folder === k);
    steps.push((m) => m.domain === null && m.folder === null && m.stem.includes(k));
  } else {
    if (domain) steps.push((m) => m.domain === domain && m.folder === null);
    steps.push((m) => m.domain === null && m.folder === null);
  }

  for (const step of steps) {
    const found = library.filter(step);
    if (found.length > 0) return found;
  }
  return [];
}
