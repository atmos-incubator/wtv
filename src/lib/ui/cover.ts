/**
 * A playlist's cover, thumbnail-shaped (16:9). Shared by the playlists page and the side
 * panel's explorer.
 *
 *   - No thumbnails: a built-in's placeholder SVG, else the name on a color block.
 *   - Four or more tiles: a quad; fewer: the first tile, full size.
 *   - A tile without a thumbnail shows the placeholder SVG (built-ins), else its title on
 *     a color block. A thumbnail that fails to load leaves the title block showing.
 *   - `cycleMs`: the quad moves on to the next four tiles (a single, to the next tile)
 *     that often, while the page is visible and the user hasn't asked for reduced motion.
 *   - Hovering or focusing `hoverTarget` plays every thumbnail full size, COVER_SLIDE_MS each.
 *
 * Timers stop themselves once the cover leaves the page, so re-rendering a list is enough.
 */
import './cover.css';

/** Frame length of the hover slideshow. */
export const COVER_SLIDE_MS = 1200;

export interface CoverTile {
  /** The thumbnail; null: none yet. */
  src: string | null;
  title: string;
  /** Picks the tile's color. */
  key: string;
}

export interface CoverOptions {
  /** Picks the placeholder's color. */
  id: string;
  name: string;
  /** In cover order. */
  tiles: readonly CoverTile[];
  /** A built-in's placeholder SVG. */
  placeholder: string | null;
  /** Default: the cover itself. */
  hoverTarget?: HTMLElement;
  /** Null: still. */
  cycleMs?: number | null;
}

/** A stable hue per id. */
export function hueOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function picture(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = src;
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

function span(className: string, text = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  if (text) s.textContent = text;
  return s;
}

function tileNode(tile: CoverTile, placeholder: string | null, turn: boolean): HTMLElement {
  const box = span(turn ? 'tile turn' : 'tile');
  box.style.setProperty('--hue', String(hueOf(tile.key)));
  box.append(span('tile-title', tile.title));
  const src = tile.src ?? placeholder;
  if (src) box.append(picture(src));
  return box;
}

const reducedMotion = (): boolean => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function cover(o: CoverOptions): HTMLElement {
  const box = span('cover');
  box.setAttribute('aria-hidden', 'true');
  const thumbs = o.tiles.map((t) => t.src).filter((s): s is string => s !== null);

  if (thumbs.length === 0) {
    if (o.placeholder) {
      box.append(picture(o.placeholder));
    } else {
      box.classList.add('placeholder');
      box.style.setProperty('--hue', String(hueOf(o.id)));
      box.append(span('tile-title', o.name));
    }
    return box;
  }

  const quad = o.tiles.length >= 4;
  const per = quad ? 4 : 1;
  box.classList.toggle('quad', quad);
  let page = 0;
  const pages = Math.ceil(o.tiles.length / per);
  const show = (turn: boolean) => {
    const group = Array.from({ length: per }, (_, k) => o.tiles[(page * per + k) % o.tiles.length]!);
    box.replaceChildren(...group.map((t) => tileNode(t, o.placeholder, turn)), ...(slide ? [slide] : []));
  };

  let hovering = false;
  let slide: HTMLImageElement | null = null;
  show(false);

  if (o.cycleMs && pages > 1 && !reducedMotion()) {
    const every = o.cycleMs;
    // Covers in a list start at different moments, so they don't all turn at once.
    setTimeout(() => {
      const timer = setInterval(() => {
        if (!box.isConnected) return clearInterval(timer);
        // Not while it's out of sight: a hidden tab, or a hidden part of the page.
        if (hovering || document.visibilityState !== 'visible' || box.offsetParent === null) return;
        page = (page + 1) % pages;
        show(true);
      }, every);
    }, Math.random() * every);
  }

  if (thumbs.length < 2 && !quad) return box;
  const target = o.hoverTarget ?? box;
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (timer !== undefined) return;
    hovering = true;
    let i = 0;
    slide = picture(thumbs[0]!);
    slide.className = 'slide';
    box.append(slide);
    timer = setInterval(() => {
      if (!box.isConnected) return stop();
      i = (i + 1) % thumbs.length;
      if (slide) slide.src = thumbs[i]!;
    }, COVER_SLIDE_MS);
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    hovering = false;
    slide?.remove();
    slide = null;
  };
  target.addEventListener('pointerenter', start);
  target.addEventListener('pointerleave', stop);
  target.addEventListener('focusin', start);
  target.addEventListener('focusout', (e) => {
    if (!target.contains(e.relatedTarget as Node | null)) stop();
  });
  return box;
}
