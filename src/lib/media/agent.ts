/**
 * ISOLATED-world media agent: discovers media, picks the primary, reports status.
 * One instance per frame. Later features (ad muting, overlays, maximize) consume
 * `primary()` / `onPrimaryChange()` from here.
 *
 * Discovery sources:
 *   1. EVT_FOUND / EVT_BRIDGE from the MAIN-world hook (play() calls, closed roots).
 *   2. Capture-phase media events on the document and on each open shadow root.
 *   3. Scans: `video, audio` in the document and known open roots, plus the site
 *      config's `video` role. Re-scanned (at most once a second) when elements are
 *      added to the DOM.
 *
 * Everything is event-driven; there is no polling loop.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { matchRole, mediaWithin } from '../dom/query';
import { isStatusRequest, type MediaStatus } from '../messages';
import { BUNDLED_SITES } from '../sites/bundled';
import { validateOverrideStore } from '../sites/overrides';
import { profileForHost, type SiteProfile } from '../sites/registry';
import { KEYS } from '../storage';
import { createDebugOverlay, type DebugOverlay } from './debug-overlay';
import { EVT_BRIDGE, EVT_FOUND, EVT_HELLO, EVT_SHADOW, parseBridgeMessage } from './protocol';
import { MediaRegistry, type MediaHandle } from './registry';
import { pickPrimary, type PrimaryChoice } from './score';

export interface MediaAgent {
  primary(): MediaHandle | null;
  onPrimaryChange(cb: (primary: MediaHandle | null) => void): () => void;
  status(): MediaStatus;
}

export interface MediaAgentOptions {
  debug: boolean;
}

const EVALUATE_DELAY_MS = 100;
const SCAN_DELAY_MS = 1000;
const DISCOVERY_EVENTS = ['play', 'playing', 'loadedmetadata'] as const;

/** Run `fn` once, `delay` ms after the first call; calls while pending are absorbed. */
function scheduler(fn: () => void, delay: number, signal: AbortSignal): () => void {
  let pending = false;
  return () => {
    if (pending || signal.aborted) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!signal.aborted) fn();
    }, delay);
  };
}

function eventMedia(e: Event): HTMLMediaElement | null {
  const target = e.composedPath()[0] ?? e.target;
  return target instanceof HTMLMediaElement ? target : null;
}

export function startMediaAgent(ctx: ContentScriptContext, options: MediaAgentOptions): MediaAgent {
  const { signal } = ctx;
  const host = location.hostname;

  let profile: SiteProfile = profileForHost(host, BUNDLED_SITES, {});
  let configVideo: HTMLMediaElement | null = null;
  let selectorErrors: string[] = [];
  let choice: PrimaryChoice | null = null;
  const listeners = new Set<(primary: MediaHandle | null) => void>();
  const openRoots = new Set<ShadowRoot>();
  const overlay: DebugOverlay | null = options.debug ? createDebugOverlay() : null;

  const evaluateSoon = scheduler(evaluate, EVALUATE_DELAY_MS, signal);
  const scanSoon = scheduler(scan, SCAN_DELAY_MS, signal);
  const registry = new MediaRegistry(evaluateSoon, signal);

  const mutations = new MutationObserver((records) => {
    let added = false;
    let removed = false;
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === Node.ELEMENT_NODE) added = true;
      if (r.removedNodes.length > 0) removed = true;
    }
    if (added) scanSoon();
    else if (removed) evaluateSoon();
  });

  function onDiscoveryEvent(e: Event): void {
    const el = eventMedia(e);
    if (el) registry.addDirect(el);
  }

  function observeRoot(root: ShadowRoot): void {
    if (openRoots.has(root)) return;
    openRoots.add(root);
    mutations.observe(root, { childList: true, subtree: true });
    for (const type of DISCOVERY_EVENTS) {
      root.addEventListener(type, onDiscoveryEvent, { capture: true, passive: true, signal });
    }
    discoverShadowRoots(root);
    scanSoon();
  }

  /** One-off walk for open roots attached before the hook ran (or declaratively). */
  function discoverShadowRoots(root: Document | ShadowRoot): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const shadow = (n as Element).shadowRoot;
      if (shadow) observeRoot(shadow);
    }
  }

  function scan(): void {
    if (registry.pruneDisconnected() > 0) evaluateSoon();

    for (const el of document.querySelectorAll('video, audio')) registry.addDirect(el as HTMLMediaElement);
    for (const root of openRoots) {
      if (!root.host.isConnected) {
        openRoots.delete(root);
        continue;
      }
      for (const el of root.querySelectorAll('video, audio')) registry.addDirect(el as HTMLMediaElement);
    }

    configVideo = null;
    selectorErrors = [];
    const matchers = profile.site?.config.roles.video;
    if (matchers) {
      const result = matchRole('video', matchers);
      selectorErrors = result.errors;
      const media = result.match ? mediaWithin(result.match.element) : null;
      if (media) {
        configVideo = media;
        registry.addDirect(media);
      }
    }
    evaluateSoon();
  }

  function evaluate(): void {
    const handles = registry.handles();
    const next = pickPrimary(
      handles.map((h) => h.features(configVideo)),
      choice?.key,
    );
    const changed = next?.key !== choice?.key;
    choice = next;
    const primary = next ? (registry.get(next.key) ?? null) : null;

    if (changed) {
      if (options.debug) console.debug('[wtv] primary media:', primary ? describe(primary) : 'none');
      for (const cb of listeners) {
        try {
          cb(primary);
        } catch (err) {
          console.error('[wtv] primary listener failed:', err);
        }
      }
    }
    overlay?.show(primary?.rect() ?? null, primary ? `wtv · ${describe(primary)}` : '');
  }

  function describe(h: MediaHandle): string {
    const f = h.features(configVideo);
    const what = f.isVideo ? 'video' : 'audio';
    const how = f.configMatch ? 'config' : 'heuristic';
    const state = f.playing ? 'playing' : 'paused';
    return `${what} · ${how} · ${state} · ${h.kind} · score ${choice?.score.toFixed(1) ?? '?'}`;
  }

  async function loadProfile(): Promise<void> {
    try {
      const raw = await browser.storage.local.get(KEYS.siteOverrides);
      const { store } = validateOverrideStore(raw[KEYS.siteOverrides]);
      profile = profileForHost(host, BUNDLED_SITES, store);
    } catch (err) {
      console.warn('[wtv] could not load site overrides, using bundled config:', err);
    }
    scanSoon();
  }

  function status(): MediaStatus {
    const primary = choice ? (registry.get(choice.key) ?? null) : null;
    const f = primary?.features(configVideo);
    const hasVideoRole = Boolean(profile.site?.config.roles.video?.length);
    return {
      profile: {
        kind: profile.kind,
        siteId: profile.site?.config.id ?? null,
        name: profile.site?.config.name ?? null,
      },
      primary:
        primary && f && choice
          ? {
              key: primary.key,
              kind: primary.kind,
              isVideo: f.isVideo,
              source: f.configMatch ? 'config' : 'heuristic',
              score: choice.score,
              playing: f.playing,
              muted: !f.audible,
              duration: Number.isFinite(f.duration) ? f.duration : null,
              live: f.duration === Infinity,
            }
          : null,
      candidates: registry.size,
      // Only meaningful while something is actually playing; on pages with no player
      // (e.g. a site's home page) the selectors are expected not to match.
      configVideoMissing: hasVideoRole && configVideo === null && Boolean(f?.playing),
      selectorErrors,
    };
  }

  // --- wiring -----------------------------------------------------------------------

  const capture = { capture: true, passive: true, signal } as const;
  for (const type of DISCOVERY_EVENTS) document.addEventListener(type, onDiscoveryEvent, capture);
  document.addEventListener(EVT_FOUND, onDiscoveryEvent, capture);
  document.addEventListener(
    EVT_SHADOW,
    (e) => {
      const hostEl = e.composedPath()[0];
      if (hostEl instanceof Element && hostEl.shadowRoot) observeRoot(hostEl.shadowRoot);
    },
    capture,
  );
  document.addEventListener(
    EVT_BRIDGE,
    (e) => {
      const msg = parseBridgeMessage((e as CustomEvent<unknown>).detail);
      if (!msg) return;
      if (msg.op === 'state') registry.updateBridged(msg.state);
      else registry.removeBridged(msg.id);
    },
    { signal },
  );

  window.addEventListener('resize', evaluateSoon, { passive: true, signal });
  window.addEventListener('scroll', evaluateSoon, capture);
  document.addEventListener('fullscreenchange', evaluateSoon, { signal });

  mutations.observe(document, { childList: true, subtree: true });

  const onStorageChanged = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && KEYS.siteOverrides in changes) void loadProfile();
  };
  browser.storage.onChanged.addListener(onStorageChanged);

  const onMessage = (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
    if (!isStatusRequest(msg)) return undefined;
    sendResponse(status());
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);

  ctx.onInvalidated(() => {
    mutations.disconnect();
    browser.storage.onChanged.removeListener(onStorageChanged);
    browser.runtime.onMessage.removeListener(onMessage);
    overlay?.destroy();
  });

  // Ask the hook to re-announce anything it saw before we were listening.
  document.dispatchEvent(new CustomEvent(EVT_HELLO));
  void loadProfile();

  const initialScan = () => {
    discoverShadowRoots(document);
    scan();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialScan, { once: true, signal });
  } else {
    initialScan();
  }

  return {
    primary: () => (choice ? (registry.get(choice.key) ?? null) : null),
    onPrimaryChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    status,
  };
}
