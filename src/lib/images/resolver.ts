/**
 * Extension-page side of `[img ...]`: library first, bundled cats as the fallback.
 */
import { browserAreas } from '../browser-storage';
import { parseSettings } from '../settings';
import { KEYS, readKey } from '../storage';
import { BUNDLED_IMAGES } from './bundled';
import { listImages } from './db';
import { resolveImages, type ImageMeta } from './library';
import type { ResolvedImage } from '../overlay/program';

export function bundledResolved(): ResolvedImage[] {
  return BUNDLED_IMAGES.map((b) => ({ src: { type: 'url', url: b.path }, durationMs: b.durationMs, isVideo: false }));
}

/** Load the library once; returns a sync resolver for buildSlides(). */
export async function createImageResolver(host: string): Promise<(keyword: string | null) => ResolvedImage[]> {
  let library: ImageMeta[] = [];
  try {
    library = await listImages();
  } catch (err) {
    console.warn('[wtv] image library unavailable, using bundled images:', err);
  }
  let defaultFolder = '';
  try {
    defaultFolder = parseSettings(await readKey<unknown>(browserAreas().local, KEYS.settings, undefined)).defaultImageFolder;
  } catch {
    // No setting: top-level files, as before.
  }
  return (keyword) => {
    const found = resolveImages(library, host, keyword, defaultFolder);
    if (found.length === 0) return bundledResolved();
    return found.map((m) => ({
      src: { type: 'library', id: m.id },
      durationMs: m.durationMs,
      isVideo: m.kind === 'video',
    }));
  };
}
