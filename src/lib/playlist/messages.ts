/**
 * Playlist runner messages.
 *
 *   content → background (runtime.sendMessage)
 *     PL_HELLO                       → EntryInfo | null   "is this page a playlist entry?" (every frame, at start)
 *     PL_MEDIA  { gen, event }                             playing / near-end / ended / blocked / gone, from frames that got an EntryInfo
 *     PL_INFO   { gen, info }                              what the page says about the entry (title, duration…), for the media library
 *     PL_PAGE_POST { gen, result }                         `view=card` read from the post's own page (top frame): the post, or why not
 *
 *   card page (card.html, in the playlist's tab: `view=card` entries) → background
 *     PL_HELLO / PL_MEDIA as above (the card page is the entry's page)
 *     PL_POST   { gen }      → PostResult   the post: read from its page (PL_PAGE_POST), else fetched by the background (posts/)
 *
 *   background → content, top frame only (tabs.sendMessage, frameId 0)
 *     PL_APPLY  { op: 'blackout', title } | { op: 'lift' } | { op: 'blocked' }  (autoplay refused in a child frame)
 *
 *   playlists page | popup → background
 *     PL_COMMAND { op: 'start', playlistId, index, tv, shuffle, loop }   plays in a new tab
 *                (index null: from the top, or a random entry when shuffling)
 *     PL_COMMAND { op: 'next' | 'previous' | 'stop' | 'resume' | 'reshuffle', tabId }
 *     PL_STATE   { tabId }          → RunnerSummary | null
 *     PL_RUNS                         → RunSummary[]   every playlist playing, in any tab
 *
 * `gen` changes every time the runner moves to an entry, so late events from the page
 * being left can't skip the next entry too.
 */
import { parseProgramItem, type ProgramItem } from '../overlay/program';
import { parsePost, type PostResult } from '../posts/adapters';
import { isViewMode, type ViewMode } from './format';

export const PL_HELLO = 'wtv/playlist/hello';
export const PL_MEDIA = 'wtv/playlist/media';
export const PL_APPLY = 'wtv/playlist/apply';
export const PL_COMMAND = 'wtv/playlist/command';
export const PL_STATE = 'wtv/playlist/state';
export const PL_INFO = 'wtv/playlist/info';
export const PL_RUNS = 'wtv/playlist/runs';
export const PL_POST = 'wtv/playlist/post';
export const PL_PAGE_POST = 'wtv/playlist/page-post';

/** `gone`: the site says the media is unavailable (the `unavailable` role). */
export const MEDIA_EVENTS = ['playing', 'near-end', 'ended', 'blocked', 'gone'] as const;
export type MediaEvent = (typeof MEDIA_EVENTS)[number];

export const STEP_OPS = ['next', 'previous', 'stop', 'resume', 'reshuffle'] as const;
export type StepOp = (typeof STEP_OPS)[number];

/** What a frame needs to know about the entry it's showing. */
export interface EntryInfo {
  gen: number;
  index: number;
  total: number;
  playlist: string;
  title: string | null;
  startS: number | null;
  /** Pause here (seconds of the media's own time); in a playlist, the next entry starts. */
  endS: number | null;
  /** The entry's ad program; null = the site's images. */
  ads: ProgramItem[] | null;
  /** `pictures`: a slideshow covers the media for the whole entry. */
  view: ViewMode;
  /** The slideshow for `view: pictures`; null = the site's images. */
  show: ProgramItem[] | null;
  /** `view: read`: words per minute; `scroll`: pixels a second; null: the default. */
  speed: number | null;
}

export type { PostResult } from '../posts/adapters';

export interface RunnerSummary {
  playlistId: string;
  name: string;
  /** Position in the play order. */
  index: number;
  /** The entry's index in the playlist. */
  entry: number;
  total: number;
  title: string | null;
  url: string;
  /** The user navigated the tab away from the entry; the runner is waiting for Resume. */
  detached: boolean;
  shuffle: boolean;
  /** Next on the last entry starts the next lap. */
  loop: boolean;
  lap: number;
}

export interface RunSummary extends RunnerSummary {
  tabId: number;
}

/** What a frame learned about its entry. Missing fields: not found. */
export interface MediaInfo {
  title?: string;
  creator?: string;
  thumbnailUrl?: string;
  durationS?: number;
  live?: boolean;
}

export type ContentRequest =
  | { type: typeof PL_HELLO }
  | { type: typeof PL_MEDIA; gen: number; event: MediaEvent }
  | { type: typeof PL_INFO; gen: number; info: MediaInfo }
  | { type: typeof PL_POST; gen: number }
  | { type: typeof PL_PAGE_POST; gen: number; result: PostResult };

export type PageRequest =
  | {
      type: typeof PL_COMMAND;
      op: 'start';
      playlistId: string;
      /** The entry to start with; null: from the top (shuffled: anywhere). */
      index: number | null;
      tv: boolean;
      shuffle: boolean;
      loop: boolean;
    }
  | { type: typeof PL_COMMAND; op: StepOp; tabId: number | null }
  | { type: typeof PL_STATE; tabId: number | null }
  | { type: typeof PL_RUNS };

export type PlaylistApply =
  | { type: typeof PL_APPLY; op: 'blackout'; title: string | null }
  | { type: typeof PL_APPLY; op: 'lift' | 'blocked' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export function parsePlaylistRequest(raw: unknown): ContentRequest | PageRequest | null {
  if (!isObj(raw)) return null;
  const tabId = isIndex(raw.tabId) ? raw.tabId : null;
  switch (raw.type) {
    case PL_HELLO:
      return { type: PL_HELLO };
    case PL_MEDIA:
      return isIndex(raw.gen) && (MEDIA_EVENTS as readonly unknown[]).includes(raw.event)
        ? { type: PL_MEDIA, gen: raw.gen, event: raw.event as MediaEvent }
        : null;
    case PL_STATE:
      return { type: PL_STATE, tabId };
    case PL_RUNS:
      return { type: PL_RUNS };
    case PL_POST:
      return isIndex(raw.gen) ? { type: PL_POST, gen: raw.gen } : null;
    case PL_PAGE_POST: {
      const result = isIndex(raw.gen) ? parsePostResult(raw.result) : null;
      return result ? { type: PL_PAGE_POST, gen: raw.gen as number, result } : null;
    }
    case PL_INFO:
      return isIndex(raw.gen) && isObj(raw.info) ? { type: PL_INFO, gen: raw.gen, info: parseMediaInfo(raw.info) } : null;
    case PL_COMMAND:
      if (raw.op === 'start') {
        if (typeof raw.playlistId !== 'string' || typeof raw.tv !== 'boolean') return null;
        if (raw.index !== null && raw.index !== undefined && !isIndex(raw.index)) return null;
        return {
          type: PL_COMMAND,
          op: 'start',
          playlistId: raw.playlistId,
          index: isIndex(raw.index) ? raw.index : null,
          tv: raw.tv,
          shuffle: raw.shuffle === true,
          loop: raw.loop === true,
        };
      }
      return (STEP_OPS as readonly unknown[]).includes(raw.op)
        ? { type: PL_COMMAND, op: raw.op as StepOp, tabId }
        : null;
    default:
      return null;
  }
}

const MAX_INFO_TEXT = 1000;

function parseMediaInfo(raw: Record<string, unknown>): MediaInfo {
  const info: MediaInfo = {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.slice(0, MAX_INFO_TEXT) : undefined);
  const title = text(raw.title);
  const creator = text(raw.creator);
  const thumbnailUrl = text(raw.thumbnailUrl);
  if (title) info.title = title;
  if (creator) info.creator = creator;
  if (thumbnailUrl && /^https?:\/\//i.test(thumbnailUrl)) info.thumbnailUrl = thumbnailUrl;
  if (typeof raw.durationS === 'number' && Number.isFinite(raw.durationS) && raw.durationS > 0) info.durationS = raw.durationS;
  if (raw.live === true) info.live = true;
  return info;
}

export function parsePlaylistApply(raw: unknown): PlaylistApply | null {
  if (!isObj(raw) || raw.type !== PL_APPLY) return null;
  if (raw.op === 'lift' || raw.op === 'blocked') return { type: PL_APPLY, op: raw.op };
  if (raw.op === 'blackout') {
    return { type: PL_APPLY, op: 'blackout', title: typeof raw.title === 'string' ? raw.title : null };
  }
  return null;
}

export function parseEntryInfo(raw: unknown): EntryInfo | null {
  if (!isObj(raw)) return null;
  const { gen, index, total, playlist, title, startS, endS, ads, view, show, speed } = raw;
  const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const program = (v: unknown) =>
    Array.isArray(v) ? v.map(parseProgramItem).filter((i): i is ProgramItem => i !== null) : null;
  if (!isIndex(gen) || !isIndex(index) || !isIndex(total) || typeof playlist !== 'string') return null;
  return {
    gen,
    index,
    total,
    playlist,
    title: typeof title === 'string' && title ? title : null,
    startS: seconds(startS),
    endS: seconds(endS),
    ads: program(ads),
    view: isViewMode(view) ? view : 'video',
    show: program(show),
    speed: typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : null,
  };
}

export function parsePostResult(raw: unknown): PostResult | null {
  if (!isObj(raw)) return null;
  if (raw.ok === true) {
    const post = parsePost(raw.post);
    return post ? { ok: true, post } : null;
  }
  if (raw.ok === false) {
    return { ok: false, gone: raw.gone === true, error: typeof raw.error === 'string' ? raw.error.slice(0, 300) : 'failed' };
  }
  return null;
}
