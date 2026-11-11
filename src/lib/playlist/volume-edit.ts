/**
 * Writing an entry's `vol=` into playlist text: by the runner (↑ / ↓ while it plays), and
 * by the playlists page, which carries such a write into unsaved edits so Save keeps it.
 * Pure.
 */
import { compilePlaylist, formatVolume, parsePlaylist, serializePlaylist, withEntryOption } from './format';
import { sameEntryUrl } from './match';

/**
 * Where the entry for `url` is in `entries`: at `index` if that's still its URL, else the
 * only entry with that URL. -1 when neither (the text changed too much to tell).
 */
export function locateEntry(entries: readonly { url: string }[], index: number, url: string): number {
  const at = entries[index];
  if (at && sameEntryUrl(at.url, url)) return index;
  const same = entries.flatMap((e, i) => (sameEntryUrl(e.url, url) ? [i] : []));
  return same.length === 1 ? same[0]! : -1;
}

/** `text` with the entry's `vol=` set (null: removed), or null if the entry can't be found. */
export function withEntryVolume(text: string, index: number, url: string, volume: number | null): string | null {
  const doc = parsePlaylist(text);
  const at = locateEntry(compilePlaylist(doc).entries, index, url);
  if (at < 0) return null;
  return serializePlaylist(withEntryOption(doc, at, 'vol', volume === null ? null : formatVolume(volume)));
}

export interface CarriedVolumes {
  text: string;
  /** Entries (in `draft`, from 0) whose `vol=` changed. */
  entries: number[];
}

/**
 * The `vol=` changes between two saved versions of a playlist (`before` → `after`),
 * made to `draft` too: each entry still at the same place with the same URL in both whose
 * volume differs. Nothing else is carried over.
 */
export function carryVolumes(before: string, after: string, draft: string): CarriedVolumes {
  const old = compilePlaylist(parsePlaylist(before)).entries;
  const now = compilePlaylist(parsePlaylist(after)).entries;
  let text = draft;
  const entries: number[] = [];
  now.forEach((e, i) => {
    const was = old[i];
    if (!was || !sameEntryUrl(was.url, e.url) || was.volume === e.volume) return;
    const doc = parsePlaylist(text);
    const at = locateEntry(compilePlaylist(doc).entries, i, e.url);
    if (at < 0) return;
    const next = serializePlaylist(withEntryOption(doc, at, 'vol', e.volume === null ? null : formatVolume(e.volume)));
    if (next === text) return;
    text = next;
    entries.push(at);
  });
  return { text, entries };
}
