/**
 * The media library as an extension page shows it: the records, and object URLs of the
 * cached thumbnails (re-made only when a thumbnail changes). Shared by the playlists page
 * and the side panel's explorer.
 */
import { getThumbnail, listRecords } from './db';
import { libraryKey, type MediaRecord } from './record';

export class LibraryView {
  records = new Map<string, MediaRecord>();
  /** Object URLs of cached thumbnails, by key, with the image URL each was cached from. */
  private readonly thumbs = new Map<string, { from: string; url: string }>();

  /** Re-read the records and the thumbnails that changed. False: the library couldn't be read. */
  async load(): Promise<boolean> {
    try {
      this.records = await listRecords();
    } catch (err) {
      console.warn('[wtv] could not read the media library:', err);
      return false;
    }
    for (const r of this.records.values()) {
      const from = r.thumbnailCachedFrom;
      const have = this.thumbs.get(r.key);
      if (!from || have?.from === from) continue;
      const blob = await getThumbnail(r.key).catch(() => null);
      if (!blob) continue;
      if (have) URL.revokeObjectURL(have.url);
      this.thumbs.set(r.key, { from, url: URL.createObjectURL(blob) });
    }
    return true;
  }

  recordFor(url: string): MediaRecord | null {
    const key = libraryKey(url);
    return key ? (this.records.get(key) ?? null) : null;
  }

  /** The cached copy, else the thumbnail's own URL. */
  src(record: MediaRecord | null): string | null {
    return (record && this.thumbs.get(record.key)?.url) ?? record?.thumbnailUrl ?? null;
  }
}
