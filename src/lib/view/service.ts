/**
 * Content-script side of maximize / TV mode / play-pause. One per frame.
 *
 * The background decides which frame acts (elect.ts) and sends VIEW_APPLY. A frame
 * told to maximize puts its primary <video> in the top layer. If it's an embedded frame,
 * that only fills the iframe, so it also asks its parent to maximize the <iframe>
 * element holding it, passing up the token the background issued. The parent verifies
 * the token with the background (the page can see and forge postMessage) and repeats
 * upward, so nested embeds fill the tab. A parent frame without Wtv running breaks the
 * chain: the video then only fills its iframe.
 *
 * Sites re-lay out for a few seconds after a resize or a page change, and some (YouTube)
 * move the player in the DOM as they do, which drops it out of the top layer silently. So
 * after each of those, and after maximizing, it's checked a few times and put back.
 *
 * Esc (in any frame that has something maximized) or losing the maximized element
 * restores the whole tab via the background. While something's maximized, ← / → skip
 * back / forward (ahead of the site's own arrow keys, so it's the same step everywhere).
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AdWatcher } from '../ads/watcher';
import type { MediaAgent } from '../media/agent';
import { skipKey } from './keys';
import { maximizeElement, reassertMaximized } from './maximize';
import {
  VIEW_COMMAND,
  VIEW_GLOBAL,
  VIEW_READY,
  VIEW_VERIFY,
  isViewToken,
  parseViewApply,
  type FrameCandidate,
  type ViewOp,
} from './messages';
import { togglePlayback } from './playback';

/** postMessage key, child frame → parent: `{ [FRAME_MSG]: token }`. */
const FRAME_MSG = 'wtv-view-frame';

/** After a maximize, resize or page change: check (ms after it) that it's still on top. */
const SETTLE_CHECKS_MS = [50, 250, 500, 1000, 2000, 3500, 5000];

export interface ViewService {
  /** This frame's own primary video is maximized (not just an iframe in it). */
  mediaMaximized(): boolean;
  /** Fires when this frame maximizes or restores something. */
  onChange(cb: () => void): () => void;
  togglePlayback(): void;
  /** Maximize or restore the tab (through the background, which picks the frame). */
  toggleMaximize(): void;
  /** Restore, and leave TV mode. */
  escape(): void;
  /** Skip the tab's show back or forward (through the background, which picks the frame). */
  skip(direction: 'back' | 'forward'): void;
}

function typingIn(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return el !== null && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
}

interface Maximized {
  el: HTMLElement;
  kind: 'media' | 'frame';
  release: () => void;
}

function command(op: ViewOp): void {
  browser.runtime.sendMessage({ type: VIEW_COMMAND, op }).catch(() => undefined);
}

/** The <iframe> (in the document or an open shadow root) whose window is `source`. */
function findFrameElement(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null;
  const roots: (Document | ShadowRoot)[] = [document];
  for (let root = roots.pop(); root; root = roots.pop()) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n as Element;
      if (el instanceof HTMLIFrameElement && el.contentWindow === source) return el;
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  return null;
}

export function startViewService(ctx: ContentScriptContext, agent: MediaAgent, ads: AdWatcher): ViewService {
  const { signal } = ctx;
  let current: Maximized | null = null;
  /** Primary key we last told the background about (TV mode maximizes on VIEW_READY). */
  let readyFor: string | null = null;
  const listeners = new Set<() => void>();
  let settleTimers: ReturnType<typeof setTimeout>[] = [];

  function notify(): void {
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        console.error('[wtv] view listener failed:', err);
      }
    }
  }

  /** Back in the top layer if the page took it out (and our overlay back above it). */
  function reassert(): void {
    if (current && reassertMaximized(current.el)) notify();
  }

  /** Check a few times over the next seconds; a new trigger starts the checks over. */
  function settle(): void {
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = current ? SETTLE_CHECKS_MS.map((ms) => setTimeout(reassert, ms)) : [];
  }

  function release(): void {
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = [];
    if (!current) return;
    const c = current;
    current = null;
    c.release();
    notify();
  }

  /** Our element was closed or removed by someone else: put the whole tab back. */
  function lost(): void {
    release();
    command('restore');
  }

  function announceUp(token: string): void {
    if (window.parent === window) return;
    window.parent.postMessage({ [FRAME_MSG]: token }, '*');
  }

  function apply(el: HTMLElement, kind: Maximized['kind']): boolean {
    if (current?.el === el) return true;
    release();
    const releaseEl = maximizeElement(el, () => {
      if (current?.el !== el) return;
      current = null;
      notify();
      command('restore');
    });
    if (!releaseEl) return false;
    current = { el, kind, release: releaseEl };
    notify();
    settle();
    return true;
  }

  function maximizeMedia(token: string): boolean {
    const el = agent.primary()?.element;
    if (!(el instanceof HTMLVideoElement) || !apply(el, 'media')) return false;
    announceUp(token);
    return true;
  }

  function candidate(): FrameCandidate {
    const f = agent.primaryFeatures();
    const isVideoEl = agent.primary()?.element instanceof HTMLVideoElement;
    return {
      maximized: current?.kind ?? null,
      video: f && isVideoEl && f.visibleArea > 0 ? { area: f.visibleArea, playing: f.playing } : null,
      media: f ? { playing: f.playing } : null,
    };
  }

  function maybeReady(): void {
    if (current) return;
    const primary = agent.primary();
    const f = agent.primaryFeatures();
    if (!primary || !(primary.element instanceof HTMLVideoElement) || !f || f.visibleArea <= 0) return;
    if (readyFor === primary.key) return;
    readyFor = primary.key;
    browser.runtime.sendMessage({ type: VIEW_READY }).catch(() => undefined);
  }

  const offPrimary = agent.onPrimaryChange((primary) => {
    if (current?.kind === 'media' && !current.el.isConnected) {
      // Some players swap <video> elements between items. Follow the new one if there is
      // one; otherwise the show is gone.
      const next = primary?.element;
      if (next instanceof HTMLVideoElement && next.isConnected) {
        const old = current;
        current = null;
        old.release();
        if (!apply(next, 'media')) lost();
      } else {
        lost();
      }
    }
    maybeReady();
    settle();
  });

  window.addEventListener('resize', settle, { passive: true, signal });
  // In-page navigation (history.pushState: YouTube's next video). Chrome has the Navigation API.
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigatesuccess', settle, { signal });
  window.addEventListener('popstate', settle, { signal });

  // Child frame asking us to maximize the iframe it lives in.
  window.addEventListener(
    'message',
    (e: MessageEvent<unknown>) => {
      const data = e.data;
      if (typeof data !== 'object' || data === null) return;
      const token = (data as Record<string, unknown>)[FRAME_MSG];
      if (!isViewToken(token)) return;
      const frame = findFrameElement(e.source);
      if (!frame) return;
      void (async () => {
        const ok: unknown = await browser.runtime.sendMessage({ type: VIEW_VERIFY, token }).catch(() => false);
        if (ok === true && apply(frame, 'frame')) announceUp(token);
      })();
    },
    { signal },
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (!current) return;
      const skip = skipKey(e);
      if (e.key !== 'Escape' && (!skip || typingIn(e.composedPath()[0] ?? e.target))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (skip) service.skip(skip);
      else service.escape();
    },
    { capture: true, signal },
  );

  const onMessage = (raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
    const msg = parseViewApply(raw);
    if (!msg) return undefined;
    switch (msg.op) {
      case 'maximize':
        sendResponse(maximizeMedia(msg.token));
        break;
      case 'restore':
        release();
        sendResponse(true);
        break;
      case 'play-pause':
        togglePlayback(agent);
        sendResponse(true);
        break;
      case 'skip':
        // Not through an ad: the site would count it skipped, or play it again.
        if (!ads.status()?.active) agent.primary()?.skip(msg.by);
        sendResponse(true);
        break;
      case 'candidate':
        sendResponse(candidate());
        break;
    }
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);

  // Read by the background with scripting.executeScript (same isolated world).
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const globalKey = Symbol.for(VIEW_GLOBAL);
  const api = { candidate };
  globals[globalKey] = api;

  ctx.onInvalidated(() => {
    browser.runtime.onMessage.removeListener(onMessage);
    offPrimary();
    if (globals[globalKey] === api) delete globals[globalKey];
    release();
  });

  const service: ViewService = {
    mediaMaximized: () => current?.kind === 'media',
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    togglePlayback: () => togglePlayback(agent),
    toggleMaximize: () => command('toggle-maximize'),
    escape() {
      release();
      command('escape');
    },
    skip: (direction) => command(direction === 'back' ? 'skip-back' : 'skip-forward'),
  };
  return service;
}
