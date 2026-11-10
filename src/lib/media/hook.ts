/**
 * MAIN-world media hook. Runs at document_start in every frame, before page scripts.
 *
 * - Wraps HTMLMediaElement.prototype.play to see every element that plays, including
 *   detached `new Audio()` players that never enter the DOM.
 * - Wraps Element.prototype.attachShadow to announce open shadow roots and to listen
 *   inside closed ones.
 * - Media the isolated world can reach (in the document or an open shadow root) is
 *   announced with EVT_FOUND on the element. Everything else is bridged: its state is
 *   posted as EVT_BRIDGE and it can be controlled with EVT_COMMAND.
 *
 * Wrappers are Proxies so `play.toString()` still reports native code, which keeps
 * the hook low-profile for pages that sniff for patched prototypes.
 *
 * No extension APIs exist in the MAIN world; this file must stay DOM-only.
 */
import {
  EVT_BLOCKED,
  EVT_BRIDGE,
  EVT_COMMAND,
  EVT_FOUND,
  EVT_HELLO,
  EVT_SHADOW,
  encodeDuration,
  skipElement,
  parseBridgeCommand,
  type BridgeMessage,
  type BridgedMediaState,
} from './protocol';
import { visibleAreaOf } from '../dom/query';

const INSTALLED = Symbol.for('wtv.media-hook');
/** Bound on bridged elements kept alive, so a page creating many players can't leak. */
const MAX_BRIDGED = 32;
const STATE_EVENTS = [
  'play',
  'pause',
  'playing',
  'ended',
  'emptied',
  'loadedmetadata',
  'durationchange',
  'volumechange',
  'seeked',
] as const;
const TIMEUPDATE_INTERVAL_MS = 1000;

export function installMediaHook(win: Window & typeof globalThis = window): void {
  const marker = win as unknown as Record<symbol, unknown>;
  if (marker[INSTALLED]) return;
  Object.defineProperty(win, INSTALLED, { value: true });

  const doc = win.document;
  const MediaProto = win.HTMLMediaElement.prototype;
  const nativePlay = MediaProto.play;
  const nativeAttachShadow = win.Element.prototype.attachShadow;
  // Captured before page scripts run, so a page patching Promise can't interfere.
  const nativeThen = win.Promise.prototype.then;

  /** Every element seen, reachable or not, so EVT_HELLO can re-announce. */
  const seen = new Set<WeakRef<HTMLMediaElement>>();
  const seenElements = new WeakSet<HTMLMediaElement>();
  const bridged = new Map<number, HTMLMediaElement>();
  const bridgeIds = new WeakMap<HTMLMediaElement, number>();
  const lastTimeupdate = new WeakMap<HTMLMediaElement, number>();
  const closedRoots = new WeakSet<ShadowRoot>();
  let nextId = 1;

  function post(message: BridgeMessage): void {
    doc.dispatchEvent(new CustomEvent(EVT_BRIDGE, { detail: JSON.stringify(message) }));
  }

  /** In the document, through open shadow roots only. */
  function isReachable(el: Element): boolean {
    let root = el.getRootNode();
    while (root instanceof ShadowRoot) {
      if (root.mode === 'closed' || closedRoots.has(root)) return false;
      root = root.host.getRootNode();
    }
    return root === doc;
  }

  function stateOf(id: number, el: HTMLMediaElement): BridgedMediaState {
    const area = el.isConnected
      ? visibleAreaOf(el.getBoundingClientRect(), win.innerWidth, win.innerHeight)
      : 0;
    return {
      id,
      isVideo: el instanceof win.HTMLVideoElement,
      paused: el.paused,
      ended: el.ended,
      muted: el.muted,
      volume: el.volume,
      loop: el.loop,
      ...encodeDuration(el.duration),
      currentTime: Number.isFinite(el.currentTime) ? el.currentTime : 0,
      hasSource: Boolean(el.currentSrc) || el.readyState > 0,
      area,
    };
  }

  function unbridge(el: HTMLMediaElement): void {
    const id = bridgeIds.get(el);
    if (id === undefined) return;
    bridgeIds.delete(el);
    bridged.delete(id);
    post({ op: 'gone', id });
  }

  function onBridgedEvent(this: HTMLMediaElement, e: Event): void {
    const el = this;
    const id = bridgeIds.get(el);
    if (id === undefined) return;
    // Elements are often created detached, played, then attached. Hand them over to
    // the isolated world as soon as it can reach them directly.
    if (isReachable(el)) {
      unbridge(el);
      el.dispatchEvent(new CustomEvent(EVT_FOUND, { bubbles: true, composed: true }));
      return;
    }
    if (e.type === 'timeupdate') {
      const now = Date.now();
      if (now - (lastTimeupdate.get(el) ?? 0) < TIMEUPDATE_INTERVAL_MS) return;
      lastTimeupdate.set(el, now);
    }
    post({ op: 'state', state: stateOf(id, el) });
  }

  function bridge(el: HTMLMediaElement): void {
    let id = bridgeIds.get(el);
    if (id === undefined) {
      if (bridged.size >= MAX_BRIDGED) {
        // Evict the oldest paused element; if none is paused, don't track this one.
        const victim = [...bridged.values()].find((m) => m.paused);
        if (!victim) return;
        unbridge(victim);
      }
      id = nextId++;
      bridgeIds.set(el, id);
      bridged.set(id, el);
      for (const type of [...STATE_EVENTS, 'timeupdate']) el.addEventListener(type, onBridgedEvent);
    }
    post({ op: 'state', state: stateOf(id, el) });
  }

  function announce(el: HTMLMediaElement): void {
    if (isReachable(el)) {
      unbridge(el);
      el.dispatchEvent(new CustomEvent(EVT_FOUND, { bubbles: true, composed: true }));
    } else {
      bridge(el);
    }
  }

  function note(el: unknown): void {
    if (!(el instanceof win.HTMLMediaElement)) return;
    if (!seenElements.has(el)) {
      seenElements.add(el);
      seen.add(new WeakRef(el));
    }
    announce(el);
  }

  /** Chrome's autoplay policy said no. Tell the isolated world (playlist blackout). */
  function onPlayRejected(el: unknown, err: unknown): void {
    if ((err as { name?: unknown } | null)?.name !== 'NotAllowedError') return;
    const event = new CustomEvent(EVT_BLOCKED, { bubbles: true, composed: true });
    if (el instanceof win.HTMLMediaElement && isReachable(el)) el.dispatchEvent(event);
    else doc.dispatchEvent(event);
  }

  MediaProto.play = new Proxy(nativePlay, {
    apply(target, thisArg: unknown, args: []) {
      try {
        note(thisArg);
      } catch {
        // Never break the page's play() call.
      }
      const result: unknown = Reflect.apply(target, thisArg, args);
      try {
        // Observe only: a separate branch, so the page's own handlers (or its unhandled
        // rejection) see exactly what they would have without us.
        if (result instanceof win.Promise) {
          Reflect.apply(nativeThen, result, [undefined, (err: unknown) => onPlayRejected(thisArg, err)]);
        }
      } catch {
        // Ignore.
      }
      return result;
    },
  });

  function onClosedRootMedia(e: Event): void {
    note(e.target);
  }

  win.Element.prototype.attachShadow = new Proxy(nativeAttachShadow, {
    apply(target, thisArg: Element, args: [ShadowRootInit]) {
      const root = Reflect.apply(target, thisArg, args) as ShadowRoot;
      try {
        if (root.mode === 'closed') {
          closedRoots.add(root);
          // Media events don't cross shadow boundaries; listen inside to catch autoplay.
          root.addEventListener('playing', onClosedRootMedia, true);
          root.addEventListener('loadedmetadata', onClosedRootMedia, true);
        } else {
          thisArg.dispatchEvent(new CustomEvent(EVT_SHADOW, { bubbles: true, composed: true }));
        }
      } catch {
        // Never break the page's attachShadow() call.
      }
      return root;
    },
  });

  doc.addEventListener(EVT_HELLO, () => {
    for (const ref of seen) {
      const el = ref.deref();
      if (el) announce(el);
      else seen.delete(ref);
    }
  });

  doc.addEventListener(EVT_COMMAND, (e) => {
    const cmd = parseBridgeCommand((e as CustomEvent<unknown>).detail);
    if (!cmd) return;
    const el = bridged.get(cmd.id);
    if (!el) return;
    switch (cmd.cmd) {
      case 'play':
        void Reflect.apply(nativePlay, el, []).catch(() => undefined);
        break;
      case 'pause':
        el.pause();
        break;
      case 'seek':
        el.currentTime = cmd.time;
        break;
      case 'skip':
        skipElement(el, cmd.by);
        break;
      case 'mute':
        el.muted = cmd.muted;
        break;
    }
  });
}
