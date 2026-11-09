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
  /**
   * Playlist transitions and loading: the ad pictures (`pictures`: the entry's `[ads]`
   * program, or the site's images) until the entry is ready; or, for a notice
   ("Unavailable: …"), black with `title`. `prompt`: offer Start / Next. `attempt`
   * counts automatic start attempts (each new one pulses the Start button); `status`
   * says how the last one went.
   */
  | {
      type: 'blackout';
      title: string | null;
      pictures: { host: string; items: ProgramItem[] } | null;
      prompt: boolean;
      attempt: number;
      status: string | null;
      /** Offer Next with Start (false for a stand-alone #wtv: link). */
      canNext: boolean;
    }
  /**
   * Transparent click shield over the video: clicks, double-clicks, pointer movement and
   * keys are reported back instead of reaching the page. `maximized` hides an idle cursor.
   * `seekBand`: px at the bottom where a click seeks (0 = none); shown as a pointer cursor.
   */
  | { type: 'shield'; maximized: boolean; seekBand: number }
  /**
   * Pictures that aren't about an ad: `pause` while the show is paused (a click resumes
   * it), `show` for a playlist entry shown as pictures (clicks play / pause; `paused` dims
   * the pictures and shows ⏸). The slideshow keeps going when only `paused` changes.
   */
  | { type: 'pictures'; purpose: PicturesPurpose; host: string; items: ProgramItem[]; paused: boolean }
  /** A small "Show pictures" button in a corner of the player, after ✕ during an ad. */
  | { type: 'pill' }
  /**
   * A page shown as an article (`view=read`): the overlay finds the article in `html` (a
   * snapshot of the page, `url` its address) with Readability and scrolls it at `wpm`, or
   * fits it into `durS`. It answers with read-started / read-failed, then read-done. `id`
   * changes per showing.
   */
  | ReadCommand
  | { type: 'hide' };

export interface ReadCommand {
  type: 'read';
  id: number;
  url: string;
  html: string;
  wpm: number;
  durS: number | null;
}

/** Page snapshots bigger than this are cut (Readability copes with the rest). */
export const MAX_READ_HTML = 8 * 1024 * 1024;

export const PICTURES_PURPOSES = ['pause', 'show'] as const;
export type PicturesPurpose = (typeof PICTURES_PURPOSES)[number];

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
  /** "Show pictures" after ✕: bring the ad pictures back. */
  | { type: 'undismiss' }
  /** Start / Next on the blackout prompt. */
  | { type: 'start' }
  | { type: 'next' }
  /** Shield or pictures clicked / double-clicked at x / y, fractions (0–1) of the overlay box. */
  | { type: 'click' | 'dblclick'; x: number; y: number }
  /** Pointer moved over the shield; x / y are fractions (0–1) of the overlay box. */
  | { type: 'activity'; x: number; y: number }
  /** `read`: the article is showing, for `durationS` in all (paused time not counted). */
  | { type: 'read-started'; id: number; durationS: number }
  /** `read`: no article on the page (show the page itself instead). */
  | { type: 'read-failed'; id: number }
  /** `read`: finished. */
  | { type: 'read-done'; id: number }
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

export function parseProgramItem(v: unknown): ProgramItem | null {
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

/** Valid items, else the site's pictures. */
function parseItems(raw: unknown[]): ProgramItem[] {
  const items = raw.slice(0, MAX_ITEMS).map(parseProgramItem).filter((i): i is ProgramItem => i !== null);
  return items.length > 0 ? items : [...DEFAULT_AD_ITEMS];
}

export function parseOverlayCommand(raw: unknown): OverlayCommand | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'hide':
    case 'pill':
      return { type: raw.type };
    case 'blackout':
      return {
        type: 'blackout',
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, MAX_TEXT) : null,
        pictures:
          isObj(raw.pictures) && typeof raw.pictures.host === 'string' && Array.isArray(raw.pictures.items)
            ? { host: raw.pictures.host, items: parseItems(raw.pictures.items) }
            : null,
        prompt: raw.prompt === true,
        attempt: Number.isInteger(raw.attempt) && (raw.attempt as number) > 0 ? (raw.attempt as number) : 0,
        status: typeof raw.status === 'string' && raw.status.trim() ? raw.status.trim().slice(0, MAX_TEXT) : null,
        canNext: raw.canNext !== false,
      };
    case 'shield': {
      if (typeof raw.maximized !== 'boolean') return null;
      const band = typeof raw.seekBand === 'number' && Number.isFinite(raw.seekBand) ? raw.seekBand : 0;
      return { type: 'shield', maximized: raw.maximized, seekBand: Math.min(200, Math.max(0, band)) };
    }
    case 'ad': {
      if (typeof raw.host !== 'string' || !Array.isArray(raw.items) || typeof raw.muted !== 'boolean') return null;
      return { type: 'ad', host: raw.host, items: parseItems(raw.items), muted: raw.muted };
    }
    case 'read': {
      const { id, url, html, wpm, durS } = raw;
      if (!Number.isInteger(id) || typeof url !== 'string' || !/^https?:\/\//i.test(url) || typeof html !== 'string') return null;
      if (!isPositive(wpm)) return null;
      return {
        type: 'read',
        id: id as number,
        url,
        html: html.slice(0, MAX_READ_HTML),
        wpm,
        durS: isPositive(durS) ? durS : null,
      };
    }
    case 'pictures': {
      if (typeof raw.host !== 'string' || !Array.isArray(raw.items) || typeof raw.paused !== 'boolean') return null;
      if (!(PICTURES_PURPOSES as readonly unknown[]).includes(raw.purpose)) return null;
      return {
        type: 'pictures',
        purpose: raw.purpose as PicturesPurpose,
        host: raw.host,
        items: parseItems(raw.items),
        paused: raw.paused,
      };
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
    case 'undismiss':
    case 'start':
    case 'next':
      return { type: raw.type };
    case 'read-started':
      return Number.isInteger(raw.id) && isPositive(raw.durationS)
        ? { type: 'read-started', id: raw.id as number, durationS: raw.durationS }
        : null;
    case 'read-failed':
    case 'read-done':
      return Number.isInteger(raw.id) ? { type: raw.type, id: raw.id as number } : null;
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
