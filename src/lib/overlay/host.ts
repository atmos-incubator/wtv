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
 * - If the target briefly has no box (the site re-laying out its player, say on first
 *   load), it stays where it last was for HOLD_MS rather than flashing what it covers.
 */
import { browser } from 'wxt/browser';
import { WTV_UI_ATTR } from '../ads/probe';
import { record } from '../dev/timeline';
import { DEV_TOOLS } from '../env';
import { OVERLAY_INIT, OVERLAY_PAGE, parseOverlayEvent, type OverlayCommand, type OverlayEvent } from './program';
import type { Box } from './shield';
import { notifyRestacked } from './top-layer';

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

const HOLD_MS = 1000;

const rectText = (r: Box) => `${Math.round(r.width)}×${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`;

/** Dev builds: a timeline of what the overlay did, to diagnose flashes. */
function trace(...args: unknown[]): void {
  if (DEV_TOOLS) record('overlay host', ...args);
}

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
  /** Whether the overlay is currently placed on a real box, and since when it's had none. */
  let placed = false;
  let lostAt = 0;

  function send(cmd: OverlayCommand): void {
    if (port) port.postMessage(cmd);
    else pending.push(cmd);
  }

  function ensure(): HTMLDivElement | null {
    if (host?.isConnected) return host;
    if (!document.documentElement || signal.aborted) return null;
    if (host) trace('the page removed the overlay; recreating it (it will be blank until it loads)');

    const token = randomToken();
    const el = document.createElement('div');
    el.style.cssText = BASE_STYLE;
    el.popover = 'manual';
    el.setAttribute(WTV_UI_ATTR, '');
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
      const now = performance.now();
      if (placed) {
        lostAt ||= now;
        if (now - lostAt < HOLD_MS) return;
      }
      if (placed) trace(`nothing to cover for ${HOLD_MS}ms; hiding`);
      host.style.visibility = 'hidden';
      lastRect = '';
      placed = false;
      lostAt = 0;
      return;
    }
    if (lostAt) trace(`box back after ${Math.round(performance.now() - lostAt)}ms`);
    else if (!placed) trace('placed', rectText(rect));
    placed = true;
    lostAt = 0;
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
    trace('restacked');
    notifyRestacked();
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
      trace('show', command.type);
      // Blackout and ad pictures are opaque: paint black from the first frame, so nothing
      // shows through before the iframe has loaded or switched over (at document_start, or
      // on the first ad, that can take a moment). The shield is see-through.
      el.style.background = command.type === 'shield' || command.type === 'pill' ? 'transparent' : '#000';
      el.style.display = 'block';
      lastRect = '';
      restack();
      cancelAnimationFrame(raf);
      loop();
    },
    hide() {
      if (!host || !target) return;
      trace('hide');
      target = null;
      placed = false;
      lostAt = 0;
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
