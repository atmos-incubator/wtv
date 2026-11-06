/**
 * What the overlay shows. Pure: commands, validation, and slide sequencing.
 *
 * Content script → overlay iframe commands travel over a MessagePort. They're validated
 * on arrival anyway (cheap, and the iframe is an extension page).
 */

export type ProgramItem =
  | { kind: 'img'; keyword: string | null; durationS: number | null }
  | { kind: 'text'; text: string; durationS: number };

export type OverlayCommand =
  /** Ad running: play `items` in order, looping, until hidden. */
  | { type: 'ad'; host: string; items: ProgramItem[]; muted: boolean }
  /** Black screen with an optional title (playlist transitions). */
  | { type: 'blackout'; title: string | null }
  /**
   * Transparent click shield over the video: clicks, double-clicks, pointer movement and
   * keys are reported back instead of reaching the page. `maximized` hides an idle cursor.
   * `seekBand`: px at the bottom where a click seeks (0 = none); shown as a pointer cursor.
   */
  | { type: 'shield'; maximized: boolean; seekBand: number }
  | { type: 'hide' };

/** A key pressed while the overlay iframe had focus, handed back to the page. */
export interface ForwardedKey {
  type: 'key';
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** Overlay → content script. */
export type OverlayEvent =
  /** ✕ on the ad overlay. */
  | { type: 'dismiss' }
  /** Shield clicked / double-clicked at x / y, fractions (0–1) of the overlay box. */
  | { type: 'click' | 'dblclick'; x: number; y: number }
  /** Pointer moved over the shield; x / y are fractions (0–1) of the overlay box. */
  | { type: 'activity'; x: number; y: number }
  | ForwardedKey;

/**
 * Handshake: the content script posts `{ type: OVERLAY_INIT, token }` with a MessagePort
 * to the iframe. The token is also in the iframe URL's hash, which the page can't read
 * (the iframe lives in a closed shadow root), so the page can't hijack the channel.
 */
export const OVERLAY_INIT = 'wtv-overlay-init';
export const OVERLAY_PAGE = '/overlay.html';

/** Default `[ads]` program when no playlist says otherwise: the site's images. */
export const DEFAULT_AD_ITEMS: readonly ProgramItem[] = [{ kind: 'img', keyword: null, durationS: null }];

export const DEFAULT_IMAGE_MS = 5000;
const MAX_ITEMS = 500;
const MAX_TEXT = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function parseItem(v: unknown): ProgramItem | null {
  if (!isObj(v)) return null;
  if (v.kind === 'img') {
    const keyword = typeof v.keyword === 'string' && v.keyword.trim() ? v.keyword.trim() : null;
    const durationS = isPositive(v.durationS) ? v.durationS : null;
    return { kind: 'img', keyword, durationS };
  }
  if (v.kind === 'text' && typeof v.text === 'string' && v.text.trim() && isPositive(v.durationS)) {
    return { kind: 'text', text: v.text.trim().slice(0, MAX_TEXT), durationS: v.durationS };
  }
  return null;
}

export function parseOverlayCommand(raw: unknown): OverlayCommand | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'hide':
      return { type: 'hide' };
    case 'blackout':
      return { type: 'blackout', title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null };
    case 'shield': {
      if (typeof raw.maximized !== 'boolean') return null;
      const band = typeof raw.seekBand === 'number' && Number.isFinite(raw.seekBand) ? raw.seekBand : 0;
      return { type: 'shield', maximized: raw.maximized, seekBand: Math.min(200, Math.max(0, band)) };
    }
    case 'ad': {
      if (typeof raw.host !== 'string' || !Array.isArray(raw.items) || typeof raw.muted !== 'boolean') return null;
      const items = raw.items.slice(0, MAX_ITEMS).map(parseItem).filter((i): i is ProgramItem => i !== null);
      return { type: 'ad', host: raw.host, items: items.length > 0 ? items : [...DEFAULT_AD_ITEMS], muted: raw.muted };
    }
    default:
      return null;
  }
}

const isFraction = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const KEY_FLAGS = ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'repeat'] as const;

export function parseOverlayEvent(raw: unknown): OverlayEvent | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'dismiss':
      return { type: 'dismiss' };
    case 'click':
    case 'dblclick':
    case 'activity':
      return isFraction(raw.x) && isFraction(raw.y) ? { type: raw.type, x: raw.x, y: raw.y } : null;
    case 'key': {
      const { key, code } = raw;
      if (typeof key !== 'string' || key.length === 0 || key.length > 32) return null;
      if (typeof code !== 'string' || code.length > 32) return null;
      if (!KEY_FLAGS.every((f) => typeof raw[f] === 'boolean')) return null;
      return {
        type: 'key',
        key,
        code,
        shiftKey: raw.shiftKey as boolean,
        ctrlKey: raw.ctrlKey as boolean,
        altKey: raw.altKey as boolean,
        metaKey: raw.metaKey as boolean,
        repeat: raw.repeat as boolean,
      };
    }
    default:
      return null;
  }
}

// --- slides ------------------------------------------------------------------------

export type ImageSource = { type: 'library'; id: string } | { type: 'url'; url: string };

export interface ResolvedImage {
  src: ImageSource;
  durationMs: number | null;
  isVideo: boolean;
}

export type Slide =
  | { kind: 'img'; src: ImageSource; isVideo: boolean; durationMs: number }
  | { kind: 'text'; text: string; durationMs: number };

export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * One pass through the program. Image items expand to their (shuffled) images; an
 * item's explicit duration beats the file name's, which beats the default.
 * The overlay loops by calling this again, so each loop gets a fresh shuffle.
 */
export function buildSlides(
  items: readonly ProgramItem[],
  resolve: (keyword: string | null) => readonly ResolvedImage[],
  rng: () => number = Math.random,
): Slide[] {
  const slides: Slide[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      slides.push({ kind: 'text', text: item.text, durationMs: item.durationS * 1000 });
      continue;
    }
    for (const img of shuffle(resolve(item.keyword), rng)) {
      slides.push({
        kind: 'img',
        src: img.src,
        isVideo: img.isVideo,
        durationMs: item.durationS !== null ? item.durationS * 1000 : (img.durationMs ?? DEFAULT_IMAGE_MS),
      });
    }
  }
  return slides;
}
