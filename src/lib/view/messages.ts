/**
 * Maximize / TV mode / playback messages.
 *
 *   content | popup → background (runtime.sendMessage)
 *     VIEW_COMMAND  { op, tabId? }  → ViewState      tabId: popup only; content uses its own tab
 *     VIEW_STATE    { tabId? }      → ViewState
 *     VIEW_READY                     a frame got a viewable video (TV mode re-maximizes on it)
 *     VIEW_VERIFY   { token }       → boolean        a child frame asked us to maximize its iframe
 *
 *   background → content (tabs.sendMessage, one frame or all)
 *     VIEW_APPLY    { op: 'maximize', token } → boolean
 *                   { op: 'restore' } | { op: 'play-pause' }
 *                   { op: 'candidate' } → FrameCandidate   (fallback when executeScript can't run)
 *
 * The background picks a frame by reading every frame's FrameCandidate (see elect.ts).
 */

export const VIEW_COMMAND = 'wtv/view/command';
export const VIEW_STATE = 'wtv/view/state';
export const VIEW_READY = 'wtv/view/ready';
export const VIEW_VERIFY = 'wtv/view/verify';
export const VIEW_APPLY = 'wtv/view/apply';

/**
 * Content scripts expose `{ candidate(): FrameCandidate }` on their isolated-world global
 * under this symbol. The background reads it from every frame with one executeScript call,
 * which reports frame ids (tabs.sendMessage to all frames returns only one answer).
 */
export const VIEW_GLOBAL = 'wtv.view';

export const VIEW_OPS = ['toggle-maximize', 'restore', 'escape', 'toggle-tv', 'play-pause', 'mute'] as const;
export type ViewOp = (typeof VIEW_OPS)[number];

export type ViewRequest =
  | { type: typeof VIEW_COMMAND; op: ViewOp; tabId: number | null }
  | { type: typeof VIEW_STATE; tabId: number | null }
  | { type: typeof VIEW_READY }
  | { type: typeof VIEW_VERIFY; token: string };

export type ViewApply =
  | { type: typeof VIEW_APPLY; op: 'maximize'; token: string }
  | { type: typeof VIEW_APPLY; op: 'restore' | 'play-pause' | 'candidate' };

export interface ViewState {
  maximized: boolean;
  /** Some frame has a video that could be maximized. */
  canMaximize: boolean;
  tv: boolean;
}

/** What one frame can offer. */
export interface FrameCandidate {
  /** What this frame has maximized: its own video, or the iframe holding a child's. */
  maximized: 'media' | 'frame' | null;
  /** The primary, when it's a video on screen. `area` in px² of this frame's viewport. */
  video: { area: number; playing: boolean } | null;
  /** The primary, video or audio. */
  media: { playing: boolean } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTabId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const TOKEN_RE = /^[0-9a-f]{32}$/;

export function isViewToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export function newViewToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseViewRequest(raw: unknown): ViewRequest | null {
  if (!isObj(raw)) return null;
  const tabId = isTabId(raw.tabId) ? raw.tabId : null;
  switch (raw.type) {
    case VIEW_COMMAND:
      return (VIEW_OPS as readonly unknown[]).includes(raw.op)
        ? { type: VIEW_COMMAND, op: raw.op as ViewOp, tabId }
        : null;
    case VIEW_STATE:
      return { type: VIEW_STATE, tabId };
    case VIEW_READY:
      return { type: VIEW_READY };
    case VIEW_VERIFY:
      return isViewToken(raw.token) ? { type: VIEW_VERIFY, token: raw.token } : null;
    default:
      return null;
  }
}

export function parseViewApply(raw: unknown): ViewApply | null {
  if (!isObj(raw) || raw.type !== VIEW_APPLY) return null;
  switch (raw.op) {
    case 'maximize':
      return isViewToken(raw.token) ? { type: VIEW_APPLY, op: 'maximize', token: raw.token } : null;
    case 'restore':
    case 'play-pause':
    case 'candidate':
      return { type: VIEW_APPLY, op: raw.op };
    default:
      return null;
  }
}

const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parseFrameCandidate(raw: unknown): FrameCandidate | null {
  if (!isObj(raw)) return null;
  const maximized = raw.maximized === 'media' || raw.maximized === 'frame' ? raw.maximized : null;
  let video: FrameCandidate['video'] = null;
  if (isObj(raw.video) && isNonNegative(raw.video.area) && typeof raw.video.playing === 'boolean') {
    video = { area: raw.video.area, playing: raw.video.playing };
  }
  let media: FrameCandidate['media'] = null;
  if (isObj(raw.media) && typeof raw.media.playing === 'boolean') media = { playing: raw.media.playing };
  return { maximized, video, media };
}
