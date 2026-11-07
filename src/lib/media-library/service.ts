/**
 * Background side of the media library: applies what the runner learns about entries,
 * caches thumbnails, and tells open extension pages (the playlists page) that it changed.
 *
 * Thumbnails are fetched on demand only, the first time an entry plays (or when its
 * thumbnail URL changes), and only from hosts Wtv has access to: the playlists page asks
 * for the sites' thumbnail hosts (`thumbnailHosts` in the site config) at Play. Without
 * access the URL is kept and fetched on a later play.
 */
import { browser } from 'wxt/browser';
import { originPatternForHost } from '../permissions';
import { patchRecord, putThumbnail } from './db';
import { LIB_CHANGED } from './messages';
import { thumbnailStale, type MediaPatch, type MediaRecord } from './record';

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const inFlight = new Set<string>();

function notify(): void {
  browser.runtime.sendMessage({ type: LIB_CHANGED }).catch(() => undefined);
}

export async function updateMedia(patch: MediaPatch): Promise<MediaRecord | null> {
  let record: MediaRecord | null = null;
  try {
    record = await patchRecord(patch);
  } catch (err) {
    console.error('[wtv] media library update failed:', err);
    return null;
  }
  notify();
  if (record && thumbnailStale(record)) void cacheThumbnail(record);
  return record;
}

async function cacheThumbnail(record: MediaRecord): Promise<void> {
  const url = record.thumbnailUrl;
  if (!url || inFlight.has(record.key)) return;
  inFlight.add(record.key);
  try {
    const origin = originPatternForHost(new URL(url).hostname);
    if (!(await browser.permissions.contains({ origins: [origin] }))) {
      console.info(`[wtv] no access to ${origin}; the thumbnail for ${record.key} waits for a later play`);
      return;
    }
    const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) throw new Error(`HTTP ${res.status} ${type}`);
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > MAX_THUMBNAIL_BYTES) throw new Error(`size ${blob.size}`);
    await putThumbnail(record.key, blob);
    await patchRecord({ url: record.url, thumbnailCachedFrom: url });
    notify();
  } catch (err) {
    console.warn(`[wtv] couldn't cache the thumbnail for ${record.key}:`, err);
  } finally {
    inFlight.delete(record.key);
  }
}
