/**
 * Preview a post's card on its own page (side panel: Fix selectors → Posts → Preview
 * card): what a playlist entry with `view=card` would show, read with the selectors as
 * saved now, over the tab until ✕ or Esc. Content script, top frame.
 *
 * The card page is framed over the tab in preview mode (`card.html?preview[&embed=1]#token`)
 * and gets the post by postMessage, with a random token from its fragment that the page
 * can't read (the frame is in a closed shadow root). Nothing is reported to a playlist.
 * An embedded player is lifted beside the card as in a playlist (embed.ts).
 */
import { WTV_UI_ATTR } from '../ads/probe';
import type { ResolvedSite } from '../sites/overrides';
import { cardFrame, showEmbed, type EmbedShow } from './embed';
import { findPostEmbed, readPagePost } from './page';
import { CARD_PREVIEW_CLOSE, CARD_PREVIEW_POST } from './preview-messages';

let current: (() => void) | null = null;

/** ✕ over everything (shown last, so above a lifted player too). */
function closeButton(onClose: () => void): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute(WTV_UI_ATTR, '');
  host.style.cssText =
    'all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647;';
  host.popover = 'manual';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    button {
      all: initial; box-sizing: border-box; display: flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 999px; cursor: pointer;
      background: rgb(0 0 0 / 0.7); color: #fff; font: 600 14px/1 system-ui, sans-serif;
      box-shadow: 0 2px 10px rgb(0 0 0 / 0.4);
    }
    button:hover, button:focus-visible { background: rgb(0 0 0 / 0.9); }
    b { font-size: 18px; font-weight: 500; }
  `;
  const button = document.createElement('button');
  button.type = 'button';
  button.title = 'Close the preview (Esc)';
  button.innerHTML = '<b aria-hidden="true">✕</b> Close preview';
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
    button.addEventListener(type, (e) => e.stopPropagation());
  }
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onClose();
  });
  root.append(style, button);
  document.documentElement.append(host);
  try {
    host.showPopover();
  } catch {
    // Fixed + max z-index.
  }
  return host;
}

export function closeCardPreview(): void {
  current?.();
}

/** Shows the card; or says why not. */
export function showCardPreview(site: ResolvedSite | null): string | null {
  closeCardPreview();
  if (!site) return 'No site config for this page yet: pick some post selectors first.';
  const { post } = readPagePost(site);
  if (!post) return 'No post found with these selectors. Pick at least the post’s text, title or pictures, on a post’s own page.';

  const token = crypto.randomUUID();
  const hasEmbed = findPostEmbed(site) !== null;
  const frame = cardFrame(hasEmbed ? 'preview=1&embed=1' : 'preview=1', token);
  let embed: EmbedShow | null = null;
  const controller = new AbortController();
  const { signal } = controller;

  frame.iframe.addEventListener(
    'load',
    () => {
      frame.iframe.contentWindow?.postMessage({ type: CARD_PREVIEW_POST, token, post }, new URL(frame.iframe.src).origin);
    },
    { once: true, signal },
  );
  if (hasEmbed) embed = showEmbed(() => findPostEmbed(site), { kind: 'card', frame });
  const close = closeButton(() => closeCardPreview());

  window.addEventListener(
    'message',
    (e: MessageEvent<unknown>) => {
      const d = e.data as { type?: unknown; token?: unknown } | null;
      if (e.source === frame.iframe.contentWindow && d?.type === CARD_PREVIEW_CLOSE && d.token === token) closeCardPreview();
    },
    { signal },
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeCardPreview();
    },
    { capture: true, signal },
  );

  current = () => {
    current = null;
    controller.abort();
    if (embed) embed.stop();
    else frame.host.remove();
    close.remove();
  };
  return null;
}
