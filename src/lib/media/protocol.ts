/**
 * Protocol between the MAIN-world media hook and the ISOLATED-world media agent.
 *
 * Both worlds share the DOM but not JS objects, so everything crosses as DOM events.
 * Event `detail` is always a JSON string: object details don't survive the world
 * boundary, and the page can see (and forge) these events, so the receiver validates.
 *
 *   EVT_FOUND   MAIN → ISO  dispatched on a reachable media element (composed, so the
 *                           isolated listener on `document` gets it via composedPath()).
 *   EVT_SHADOW  MAIN → ISO  dispatched on a host after an *open* shadow root is attached.
 *   EVT_BRIDGE  MAIN → ISO  on `document`: state of media the isolated world can't reach
 *                           (detached `new Audio()`, or inside a closed shadow root).
 *   EVT_COMMAND ISO → MAIN  on `document`: control a bridged media element.
 *   EVT_HELLO   ISO → MAIN  on `document`: isolated agent started; re-announce everything.
 *   EVT_BLOCKED MAIN → ISO  a page's play() was rejected by the autoplay policy
 *                           (NotAllowedError). On the element when reachable, else on
 *                           `document`. No detail.
 */

export const EVT_FOUND = 'wtv:media-found';
export const EVT_SHADOW = 'wtv:shadow-root';
export const EVT_BRIDGE = 'wtv:media-bridge';
export const EVT_COMMAND = 'wtv:media-command';
export const EVT_HELLO = 'wtv:media-hello';
export const EVT_BLOCKED = 'wtv:media-blocked';

export interface BridgedMediaState {
  id: number;
  isVideo: boolean;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  loop: boolean;
  /** Finite duration in seconds, or null when unknown. */
  duration: number | null;
  /** True for live / unbounded streams (duration === Infinity). */
  live: boolean;
  currentTime: number;
  hasSource: boolean;
  /** Visible area in the frame's viewport, px². 0 for detached elements. */
  area: number;
}

export type BridgeMessage = { op: 'state'; state: BridgedMediaState } | { op: 'gone'; id: number };

export type BridgeCommand =
  | { id: number; cmd: 'play' }
  | { id: number; cmd: 'pause' }
  | { id: number; cmd: 'seek'; time: number }
  /** Seconds back (−) or forward from where it is now (the page's state can be stale). */
  | { id: number; cmd: 'skip'; by: number }
  | { id: number; cmd: 'mute'; muted: boolean }
  | { id: number; cmd: 'volume'; volume: number };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseState(v: unknown): BridgedMediaState | null {
  if (!isObj(v)) return null;
  const { id, isVideo, paused, ended, muted, volume, loop, duration, live, currentTime, hasSource, area } = v;
  if (!isId(id)) return null;
  if (![isVideo, paused, ended, muted, loop, live, hasSource].every(isBool)) return null;
  if (!isNum(volume) || !isNum(currentTime) || !isNum(area)) return null;
  if (duration !== null && !isNum(duration)) return null;
  return {
    id,
    isVideo: isVideo as boolean,
    paused: paused as boolean,
    ended: ended as boolean,
    muted: muted as boolean,
    volume,
    loop: loop as boolean,
    duration: duration as number | null,
    live: live as boolean,
    currentTime,
    hasSource: hasSource as boolean,
    area: Math.max(0, area),
  };
}

export function parseBridgeMessage(raw: unknown): BridgeMessage | null {
  const v = parseJson(raw);
  if (!isObj(v)) return null;
  if (v.op === 'gone') return isId(v.id) ? { op: 'gone', id: v.id } : null;
  if (v.op === 'state') {
    const state = parseState(v.state);
    return state ? { op: 'state', state } : null;
  }
  return null;
}

export function parseBridgeCommand(raw: unknown): BridgeCommand | null {
  const v = parseJson(raw);
  if (!isObj(v) || !isId(v.id)) return null;
  switch (v.cmd) {
    case 'play':
    case 'pause':
      return { id: v.id, cmd: v.cmd };
    case 'seek':
      return isNum(v.time) && v.time >= 0 ? { id: v.id, cmd: 'seek', time: v.time } : null;
    case 'skip':
      return isNum(v.by) && v.by !== 0 && Math.abs(v.by) <= 3600 ? { id: v.id, cmd: 'skip', by: v.by } : null;
    case 'mute':
      return isBool(v.muted) ? { id: v.id, cmd: 'mute', muted: v.muted } : null;
    case 'volume':
      return isNum(v.volume) && v.volume >= 0 && v.volume <= 1 ? { id: v.id, cmd: 'volume', volume: v.volume } : null;
    default:
      return null;
  }
}

/** ↑ / ↓ change the volume this much (of 1). */
export const VOLUME_STEP = 0.1;

/**
 * The volume after a step `by` from `current`: within 0–1, on the step grid (a site's 0.73
 * goes to 0.8, not 0.83), to two places. Pure.
 */
export function volumeTarget(current: number, by: number): number {
  const from = Number.isFinite(current) ? Math.min(1, Math.max(0, current)) : 1;
  const steps = from / VOLUME_STEP;
  // Already on the grid (give or take float noise): a whole step; else to the next line.
  const onGrid = Math.abs(steps - Math.round(steps)) < 0.01;
  const next = by > 0 ? (onGrid ? Math.round(steps) + 1 : Math.ceil(steps)) : onGrid ? Math.round(steps) - 1 : Math.floor(steps);
  return Math.round(Math.min(1, Math.max(0, next * VOLUME_STEP)) * 100) / 100;
}

/** Encode a media duration for JSON (Infinity and NaN don't survive JSON). */
export function encodeDuration(d: number): { duration: number | null; live: boolean } {
  if (d === Infinity) return { duration: null, live: true };
  return { duration: Number.isFinite(d) ? d : null, live: false };
}

/**
 * Where skipping `by` seconds from `current` lands: within the media (finite duration), or
 * a live stream's seekable window (DVR). Null when there's nothing to skip within. Pure.
 */
export function skipTarget(
  current: number,
  by: number,
  duration: number,
  seekable: { start: number; end: number } | null,
): number | null {
  if (!Number.isFinite(current)) return null;
  const finite = Number.isFinite(duration) && duration > 0;
  if (!finite && !(seekable && seekable.end > seekable.start)) return null;
  const lo = !finite && seekable ? seekable.start : 0;
  const hi = finite ? duration : seekable!.end;
  return Math.min(hi, Math.max(lo, current + by));
}

/** Skip a media element `by` seconds (see skipTarget). */
export function skipElement(el: HTMLMediaElement, by: number): void {
  const r = el.seekable;
  const seekable = r.length > 0 ? { start: r.start(0), end: r.end(r.length - 1) } : null;
  const t = skipTarget(el.currentTime, by, el.duration, seekable);
  if (t !== null) el.currentTime = t;
}
