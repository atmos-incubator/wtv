/**
 * Start a playlist from an extension page (the playlists page, the side panel's
 * explorer). Call it straight from the click: it may ask for site access, which needs the
 * user's gesture.
 *
 * Wtv only runs where it has host access, so it asks for every entry's site up front, so
 * the runner can detect each video's end; and for those sites' thumbnail hosts, so the
 * media library can cache thumbnails, unless the user said no to those before
 * (remembered in this origin's localStorage, shared by every Wtv page).
 */
import { browser } from 'wxt/browser';
import { thumbnailOriginsFor } from '../media-library/record';
import { BUNDLED_SITES } from '../sites/bundled';
import { compilePlaylist, parsePlaylist } from './format';
import { originPatternsFor } from './match';
import { PL_COMMAND } from './messages';

/** Thumbnail hosts the user said no to at Play: not asked for again. */
const DECLINED_THUMBNAILS = 'wtv.playlists.declinedThumbnailOrigins';

export interface PlayOptions {
  /** The entry to start with (playlist order); null: from the top, or anywhere when shuffling. */
  index: number | null;
  tv: boolean;
  /** Default: the playlist's own `[shuffle]` / `[loop]` lines. */
  shuffle?: boolean;
  loop?: boolean;
}

export type PlayResult =
  | { ok: true; /** Some entries' sites weren't granted. */ partial: boolean }
  | { ok: false; error: string };

export async function playPlaylist(p: { id: string; text: string }, o: PlayOptions): Promise<PlayResult> {
  const compiled = compilePlaylist(parsePlaylist(p.text));
  if (compiled.entries.length === 0) return { ok: false, error: 'it has no entries' };

  const urls = compiled.entries.map((e) => e.url);
  const origins = originPatternsFor(urls);
  const declined = declinedThumbnails();
  const thumbnailOrigins = thumbnailOriginsFor(urls, BUNDLED_SITES).filter((o) => !declined.has(o));
  let granted = await browser.permissions.contains({ origins });
  const thumbsGranted = await browser.permissions.contains({ origins: thumbnailOrigins });
  if (!granted || !thumbsGranted) {
    const ok = await browser.permissions.request({ origins: [...origins, ...thumbnailOrigins] }).catch(() => false);
    if (!ok && !thumbsGranted) rememberDeclined([...declined, ...thumbnailOrigins]);
    granted = ok || (await browser.permissions.contains({ origins }));
  }

  const result: unknown = await browser.runtime.sendMessage({
    type: PL_COMMAND,
    op: 'start',
    playlistId: p.id,
    index: o.index,
    tv: o.tv,
    shuffle: o.shuffle ?? compiled.shuffle,
    loop: o.loop ?? compiled.loop,
  });
  const error = (result as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return { ok: false, error };
  return { ok: true, partial: !granted };
}

/** Said when a playlist plays without access to some of its sites. */
export const PARTIAL_ACCESS_NOTE =
  'Without site access Wtv can’t tell when some videos end there; use Next (Alt+Shift+N).';

function declinedThumbnails(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DECLINED_THUMBNAILS) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberDeclined(origins: readonly string[]): void {
  try {
    localStorage.setItem(DECLINED_THUMBNAILS, JSON.stringify([...new Set(origins)]));
  } catch {
    // Storage blocked: we'll ask again next time.
  }
}
