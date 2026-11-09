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
 */
import { browser } from 'wxt/browser';
import { WTV_UI_ATTR } from '../ads/probe';
import { maximizeElement, placeMaximized } from '../view/maximize';
import { embedLayout } from './embed-layout';

export interface EmbedShow {
  stop(): void;
}

const RECHECK_MS = 1000;

function playVideos(el: HTMLElement): void {
  const videos =
    el instanceof HTMLVideoElement
      ? [el]
      : [...el.querySelectorAll('video'), ...(el.shadowRoot?.querySelectorAll('video') ?? [])];
  for (const v of videos) {
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

/**
 * `find`: the player (posts/page.ts findPostEmbed), looked up again whenever it's lost.
 * `card`: beside the card page in `frame` (cardFrame, with `embed=1`); removed on stop.
 */
export function showEmbed(find: () => HTMLElement | null, how: { kind: 'card'; frame: CardFrame } | { kind: 'full' }): EmbedShow {
  const frame = how.kind === 'card' ? how.frame.host : null;
  const controller = new AbortController();
  let lifted: { el: HTMLElement; release: () => void } | null = null;

  const place = () => {
    if (lifted && how.kind === 'card') placeMaximized(lifted.el, embedLayout(window.innerWidth, window.innerHeight).slot);
  };

  function lift(): void {
    if (lifted?.el.isConnected) return;
    lifted?.release();
    lifted = null;
    const el = find();
    if (!el) return;
    // After the card frame: the top layer stacks in the order things are shown.
    const release = maximizeElement(el, () => {
      if (lifted?.el === el) lifted = null;
    });
    if (!release) return;
    lifted = { el, release };
    place();
    playVideos(el);
  }

  lift();
  window.addEventListener('resize', place, { passive: true, signal: controller.signal });
  const recheck = setInterval(lift, RECHECK_MS);
  return {
    stop() {
      controller.abort();
      clearInterval(recheck);
      lifted?.release();
      lifted = null;
      frame?.remove();
    },
  };
}
