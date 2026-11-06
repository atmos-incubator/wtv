/**
 * Playlist runner messages.
 *
 *   content → background (runtime.sendMessage)
 *     PL_HELLO                       → EntryInfo | null   "is this page a playlist entry?" (every frame, at start)
 *     PL_MEDIA  { gen, event }                             playing / near-end / ended, from frames that got an EntryInfo
 *
 *   background → content, top frame only (tabs.sendMessage, frameId 0)
 *     PL_APPLY  { op: 'blackout', title } | { op: 'lift' }
 *
 *   playlists page | popup → background
 *     PL_COMMAND { op: 'start', playlistId, index, tv }    plays in a new tab
 *     PL_COMMAND { op: 'next' | 'previous' | 'stop' | 'resume', tabId }
 *     PL_STATE   { tabId }          → RunnerSummary | null
 *
 * `gen` changes every time the runner moves to an entry, so late events from the page
 * being left can't skip the next entry too.
 */
import { parseProgramItem, type ProgramItem } from '../overlay/program';

export const PL_HELLO = 'wtv/playlist/hello';
export const PL_MEDIA = 'wtv/playlist/media';
export const PL_APPLY = 'wtv/playlist/apply';
export const PL_COMMAND = 'wtv/playlist/command';
export const PL_STATE = 'wtv/playlist/state';

export const MEDIA_EVENTS = ['playing', 'near-end', 'ended'] as const;
export type MediaEvent = (typeof MEDIA_EVENTS)[number];

export const STEP_OPS = ['next', 'previous', 'stop', 'resume'] as const;
export type StepOp = (typeof STEP_OPS)[number];

/** What a frame needs to know about the entry it's showing. */
export interface EntryInfo {
  gen: number;
  index: number;
  total: number;
  playlist: string;
  title: string | null;
  startS: number | null;
  /** The entry's ad program; null = the site's images. */
  ads: ProgramItem[] | null;
}

export interface RunnerSummary {
  playlistId: string;
  name: string;
  index: number;
  total: number;
  title: string | null;
  url: string;
  /** The user navigated the tab away from the entry; the runner is waiting for Resume. */
  detached: boolean;
}

export type ContentRequest = { type: typeof PL_HELLO } | { type: typeof PL_MEDIA; gen: number; event: MediaEvent };

export type PageRequest =
  | { type: typeof PL_COMMAND; op: 'start'; playlistId: string; index: number; tv: boolean }
  | { type: typeof PL_COMMAND; op: StepOp; tabId: number | null }
  | { type: typeof PL_STATE; tabId: number | null };

export type PlaylistApply = { type: typeof PL_APPLY; op: 'blackout'; title: string | null } | { type: typeof PL_APPLY; op: 'lift' };

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
    case PL_COMMAND:
      if (raw.op === 'start') {
        return typeof raw.playlistId === 'string' && isIndex(raw.index) && typeof raw.tv === 'boolean'
          ? { type: PL_COMMAND, op: 'start', playlistId: raw.playlistId, index: raw.index, tv: raw.tv }
          : null;
      }
      return (STEP_OPS as readonly unknown[]).includes(raw.op)
        ? { type: PL_COMMAND, op: raw.op as StepOp, tabId }
        : null;
    default:
      return null;
  }
}

export function parsePlaylistApply(raw: unknown): PlaylistApply | null {
  if (!isObj(raw) || raw.type !== PL_APPLY) return null;
  if (raw.op === 'lift') return { type: PL_APPLY, op: 'lift' };
  if (raw.op === 'blackout') {
    return { type: PL_APPLY, op: 'blackout', title: typeof raw.title === 'string' ? raw.title : null };
  }
  return null;
}

export function parseEntryInfo(raw: unknown): EntryInfo | null {
  if (!isObj(raw)) return null;
  const { gen, index, total, playlist, title, startS, ads } = raw;
  if (!isIndex(gen) || !isIndex(index) || !isIndex(total) || typeof playlist !== 'string') return null;
  return {
    gen,
    index,
    total,
    playlist,
    title: typeof title === 'string' && title ? title : null,
    startS: typeof startS === 'number' && Number.isFinite(startS) && startS >= 0 ? startS : null,
    ads: Array.isArray(ads)
      ? ads.map(parseProgramItem).filter((i): i is ProgramItem => i !== null)
      : null,
  };
}
