/**
 * A post's embedded player, shown where it is (content script, top frame, DOM).
 *
 * The player (`postEmbed` role: usually an <iframe> from another site) can't be copied
 * to the card page: moving an iframe reloads it, and many players only run framed by
 * their own site. So it stays in the post's page and is lifted into the top layer
 * (view/maximize.ts) above everything else:
 *
 *   - `card`: the card page (card.html?embed) is framed over the whole tab first, and
 *     lays the post out beside an empty slot (embed-layout.ts); the player is lifted
 *     after it, so above it, into that slot. The card page does the rest as usual
 *     (hello, the post, timing, `ended`).
 *   - `full`: the player fills the tab (`view=video` when nothing else plays).
 *
 * Why the top layer and not z-index / transforms: z-index can't get out of the site's
 * stacking contexts or overflow clipping, and the top layer can (see maximize.ts).
 * A <video> in it is played (it was paused while the post was read); an iframe's player
 * is its own, so it may want a click.
 *
 * If the page takes the player away (re-renders it, closes our popover), it's looked
 * for again every second and lifted again when it's back.
 *
 * A clear shield lies over the lifted player (all but its control strip), like the
 * overlay's over a video: a click plays / pauses it instead of reaching the site, which
 * would open its own viewer or the post. A <video> in the page is played / paused
 * directly (⏸ shows on the shield while paused); a player in an iframe through the
 * background (`play-pause`, to the frame playing). With a card, it and the player pause
 * together, whichever is clicked (CARD_PAUSED). After the shield enters the top layer,
 * the playlist's arrows are told to go back above it (notifyRestacked).
 */
import { browser } from 'wxt/browser';
import { WTV_UI_ATTR } from '../ads/probe';
import { DEFAULT_CONTROL_INSET } from '../overlay/shield';
import { notifyRestacked } from '../overlay/top-layer';
import { VIEW_COMMAND } from '../view/messages';
import { maximizeElement, placeMaximized, reassertMaximized } from '../view/maximize';
import { embedLayout } from './embed-layout';
import { CARD_PAUSED, CARD_POINTER } from './preview-messages';

export interface EmbedShow {
  stop(): void;
}

const RECHECK_MS = 1000;

function videosIn(el: HTMLElement): HTMLVideoElement[] {
  return el instanceof HTMLVideoElement
    ? [el]
    : [...el.querySelectorAll('video'), ...(el.shadowRoot?.querySelectorAll('video') ?? [])];
}

function playVideos(el: HTMLElement): void {
  for (const v of videosIn(el)) {
    v.play().catch(() => {
      // Refused (autoplay): its own controls are on screen.
      v.controls = true;
    });
  }
}

export interface CardFrame {
  host: HTMLElement;
  iframe: HTMLIFrameElement;
}

/**
 * The card page framed over the whole tab (below the player, when there is one).
 * `query`: card.html's, e.g. `gen=3&embed=1`; `hash`: its fragment (a preview's token).
 */
export function cardFrame(query: string, hash = ''): CardFrame {
  const host = document.createElement('div');
  host.setAttribute(WTV_UI_ATTR, '');
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0; padding: 0; border: 0; background: #000; z-index: 2147483647;';
  host.popover = 'manual';
  const root = host.attachShadow({ mode: 'closed' });
  const iframe = document.createElement('iframe');
  iframe.src = browser.runtime.getURL(`/card.html?${query}${hash ? `#${hash}` : ''}`);
  iframe.allow = 'autoplay';
  iframe.style.cssText = 'all: initial; display: block; width: 100%; height: 100%; border: 0;';
  root.append(iframe);
  document.documentElement.append(host);
  try {
    host.showPopover();
  } catch {
    // Fixed + max z-index still covers the page.
  }
  return { host, iframe };
}

interface Shield {
  place(rect: DOMRect | null): void;
  /** Back on top (after the player re-entered the top layer). */
  raise(): void;
  setPaused(paused: boolean): void;
  remove(): void;
}

const SHIELD_STYLE = `
  :host { cursor: pointer; }
  div {
    all: initial; position: absolute; inset: 0; display: grid; place-items: center;
    font: clamp(32px, 7vw, 96px)/1 system-ui, sans-serif; color: #fff;
    text-shadow: 0 2px 18px rgb(0 0 0 / 0.6); pointer-events: none;
  }
  div[hidden] { display: none; }
`;

/** The clear cover over the lifted player. */
function createShield(onToggle: () => void): Shield {
  const host = document.createElement('div');
  host.setAttribute(WTV_UI_ATTR, '');
  host.style.cssText =
    'all: initial; position: fixed; margin: 0; padding: 0; border: 0; background: transparent; overflow: hidden; z-index: 2147483647; cursor: pointer;';
  host.popover = 'manual';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = SHIELD_STYLE;
  const mark = document.createElement('div');
  mark.textContent = '⏸';
  mark.hidden = true;
  root.append(style, mark);
  // The site mustn't see these: it would open its viewer, or the post.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    host.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type !== 'contextmenu') e.preventDefault();
    });
  }
  host.addEventListener('click', onToggle);
  document.documentElement.append(host);

  const raise = () => {
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Fixed + max z-index.
    }
    notifyRestacked();
  };

  return {
    place(rect) {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        host.style.visibility = 'hidden';
        return;
      }
      // The player's own control strip (sound, full screen) stays reachable.
      const inset = rect.height > DEFAULT_CONTROL_INSET * 3 ? DEFAULT_CONTROL_INSET : 0;
      Object.assign(host.style, {
        visibility: 'visible',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height - inset}px`,
      });
    },
    raise,
    setPaused(paused) {
      mark.hidden = !paused;
    },
    remove() {
      host.remove();
    },
  };
}

/**
 * `find`: the player (posts/page.ts findPostEmbed), looked up again whenever it's lost.
 * `card`: beside the card page in `frame` (cardFrame, with `embed=1`); removed on stop.
 * `onPointer`: the pointer moved over the card (the page doesn't see that).
 * `onPaused`: the viewer paused or played it (shield or card).
 */
export function showEmbed(
  find: () => HTMLElement | null,
  how: { kind: 'card'; frame: CardFrame } | { kind: 'full' },
  hooks: { onPointer?: () => void; onPaused?: (paused: boolean) => void } = {},
): EmbedShow {
  const frame = how.kind === 'card' ? how.frame : null;
  const controller = new AbortController();
  const { signal } = controller;
  let lifted: { el: HTMLElement; release: () => void } | null = null;
  /** Paused by the viewer (shield or card): a player lifted again stays paused. */
  let paused = false;
  const shield = createShield(() => setPaused(!paused, true));

  function tellCard(): void {
    if (!frame) return;
    frame.iframe.contentWindow?.postMessage({ type: CARD_PAUSED, paused }, new URL(frame.iframe.src).origin);
  }

  /** `fromShield`: the card is told too (it told us otherwise). */
  function setPaused(on: boolean, fromShield: boolean): void {
    paused = on;
    const videos = lifted ? videosIn(lifted.el) : [];
    if (videos.length) {
      for (const v of videos) {
        if (on) v.pause();
        else void v.play().catch(() => undefined);
      }
    } else if (lifted) {
      // A player in an iframe: the frame that plays it (Wtv runs there when it may).
      browser.runtime.sendMessage({ type: VIEW_COMMAND, op: 'play-pause' }).catch(() => undefined);
    }
    shield.setPaused(on && videos.length > 0);
    if (fromShield) tellCard();
    hooks.onPaused?.(on);
  }

  const place = () => {
    if (lifted && how.kind === 'card') placeMaximized(lifted.el, embedLayout(window.innerWidth, window.innerHeight).slot);
    shield.place(lifted ? lifted.el.getBoundingClientRect() : null);
  };

  function lift(): void {
    if (lifted?.el.isConnected) {
      // Moved by the page: back in the top layer, and the shield back above it.
      if (reassertMaximized(lifted.el)) shield.raise();
      place();
      return;
    }
    lifted?.release();
    lifted = null;
    const el = find();
    if (!el) {
      place();
      return;
    }
    // After the card frame: the top layer stacks in the order things are shown.
    const release = maximizeElement(el, () => {
      if (lifted?.el === el) lifted = null;
    });
    if (!release) return;
    lifted = { el, release };
    place();
    shield.raise();
    if (!paused) playVideos(el);
    // ⏸ follows the video itself too (its own controls, the end).
    for (const v of videosIn(el)) {
      for (const type of ['play', 'pause']) {
        v.addEventListener(type, () => shield.setPaused(v.paused && !v.ended), { signal });
      }
    }
  }

  window.addEventListener(
    'message',
    (e: MessageEvent<unknown>) => {
      if (!frame || e.source !== frame.iframe.contentWindow) return;
      const d = e.data as { type?: unknown; paused?: unknown } | null;
      if (d?.type === CARD_POINTER) hooks.onPointer?.();
      else if (d?.type === CARD_PAUSED && typeof d.paused === 'boolean' && d.paused !== paused) setPaused(d.paused, false);
    },
    { signal },
  );

  lift();
  window.addEventListener('resize', place, { passive: true, signal });
  const recheck = setInterval(lift, RECHECK_MS);
  return {
    stop() {
      controller.abort();
      clearInterval(recheck);
      lifted?.release();
      lifted = null;
      shield.remove();
      frame?.host.remove();
    },
  };
}
