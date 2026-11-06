/**
 * The bundled fallback pack (public/cats). Original SVG drawings, so no licensing to
 * track. Used whenever the user's library has nothing for a request.
 */
import { parseImageFilename } from './filename';

const FILES = ['sleepy_d8s.svg', 'peek_d7s.svg', 'box_d8s.svg', 'loaf_d7s.svg'] as const;

export interface BundledImage {
  /** Extension-relative path, e.g. "/cats/sleepy_d8s.svg". */
  path: string;
  durationMs: number | null;
}

export const BUNDLED_IMAGES: readonly BundledImage[] = FILES.map((file) => ({
  path: `/cats/${file}`,
  durationMs: parseImageFilename(file)?.durationMs ?? null,
}));
