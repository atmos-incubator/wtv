/**
 * Content-script side of the overlay: an extension-page iframe placed over a target
 * rect (the primary video, or the viewport).
 *
 * - The iframe sits in a *closed* shadow root on a popover host. The page can't reach
 *   into it, so it can't read the handshake token or restyle the overlay. Showing the
 *   popover puts it in the top layer, above everything, including fullscreen players.
 * - Covering the video doubles as a click shield: ad clicks can't reach the page.
 * - Created lazily (or preloaded), kept alive between shows so the next ad is instant.
 * - While visible, a rAF loop keeps it glued to the target rect. rAF doesn't run in
 *   background tabs, which is fine because nothing is painted there either.
 */
import { browser } from 'wxt/browser';
import { OVERLAY_INIT, OVERLAY_PAGE, parseOverlayEvent, type OverlayCommand, type OverlayEvent } from './program';
import type { Box } from './shield';

export type OverlayTarget = () => Box | 'viewport' | null;

export interface OverlayHost {
  /** Create the iframe now so the first show is instant. */
  preload(): void;
  show(command: Exclude<OverlayCommand, { type: 'hide' }>, target: OverlayTarget): void;
  hide(): void;
  /** Re-enter the top layer, above anything that entered it after us (fullscreen, maximize). */
  restack(): void;
  onEvent(cb: (event: OverlayEvent) => void): () => void;
}

const BASE_STYLE = [
  'all: initial',
  'position: fixed',
  'inset: auto',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'background: transparent',
  'overflow: hidden',
  'z-index: 2147483647',
  'display: none',
].join(';');

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createOverlayHost(signal: AbortSignal): OverlayHost {
  let host: HTMLDivElement | null = null;
  let port: MessagePort | null = null;
  const pending: OverlayCommand[] = [];
  const listeners = new Set<(event: OverlayEvent) => void>();
  let target: OverlayTarget | null = null;
  let raf = 0;
  let lastRect = '';

  function send(cmd: OverlayCommand): void {
    if (port) port.postMessage(cmd);
    else pending.push(cmd);
  }

  function ensure(): HTMLDivElement | null {
    if (host?.isConnected) return host;
    if (!document.documentElement || signal.aborted) return null;

    const token = randomToken();
    const el = document.createElement('div');
    el.style.cssText = BASE_STYLE;
    el.popover = 'manual';
    const root = el.attachShadow({ mode: 'closed' });
    const iframe = document.createElement('iframe');
    iframe.src = `${browser.runtime.getURL(OVERLAY_PAGE)}#${token}`;
    iframe.allow = 'autoplay';
    iframe.style.cssText = 'all: initial; display: block; width: 100%; height: 100%; border: 0;';
    iframe.addEventListener(
      'load',
      () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (m: MessageEvent<unknown>) => {
          const event = parseOverlayEvent(m.data);
          if (event) for (const cb of listeners) cb(event);
        };
        iframe.contentWindow?.postMessage({ type: OVERLAY_INIT, token }, new URL(iframe.src).origin, [
          channel.port2,
        ]);
        port = channel.port1;
        for (const cmd of pending.splice(0)) port.postMessage(cmd);
      },
      { once: true },
    );
    root.append(iframe);
    document.documentElement.append(el);
    host = el;
    port = null;
    return el;
  }

  function place(): void {
    if (!host || !target) return;
    const t = target();
    let rect: Box;
    if (t === 'viewport') rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    else if (t && t.width > 0 && t.height > 0) rect = t;
    else {
      host.style.visibility = 'hidden';
      lastRect = '';
      return;
    }
    const key = `${rect.left},${rect.top},${rect.width},${rect.height}`;
    if (key === lastRect) return;
    lastRect = key;
    Object.assign(host.style, {
      visibility: 'visible',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function loop(): void {
    place();
    raf = requestAnimationFrame(loop);
  }

  /** Re-enter the top layer so we stack above anything that went fullscreen after us. */
  function restack(): void {
    if (!host || !target) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Not connected; ensure() on the next show will recreate it.
    }
  }

  document.addEventListener('fullscreenchange', restack, { signal });
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(raf);
    host?.remove();
  });

  return {
    preload() {
      ensure();
    },
    show(command, t) {
      const el = ensure();
      if (!el) return;
      target = t;
      send(command);
      el.style.display = 'block';
      lastRect = '';
      restack();
      cancelAnimationFrame(raf);
      loop();
    },
    hide() {
      if (!host || !target) return;
      target = null;
      cancelAnimationFrame(raf);
      send({ type: 'hide' });
      try {
        if (host.matches(':popover-open')) host.hidePopover();
      } catch {
        // Ignore.
      }
      host.style.display = 'none';
    },
    restack,
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
