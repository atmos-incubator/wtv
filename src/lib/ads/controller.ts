/**
 * Background ad controller.
 *
 * Frames report ad state over AD_PORT (one port per frame, open only during an ad).
 * Per tab: "ad showing" = any frame active → badge. "want mute" = any active frame with
 * mute on → decideMute() → chrome.tabs.update({ muted }).
 *
 * Frame state is in memory (ports die with the worker, and frames reconnect). Mute
 * ownership is in storage.session so a worker restart mid-ad still unmutes correctly.
 * After a restart, tabs we muted whose frames never reconnect are reconciled (unmuted)
 * once a short grace period passes.
 */
import { browser } from 'wxt/browser';
import { KEYS } from '../storage';
import { decideMute, IDLE, type MutedInfo, type TabMuteState } from './mute';
import { AD_PORT, parseAdPortMessage, type AdPortMessage } from './protocol';

const RECOVERY_GRACE_MS = 5000;
const BADGE_TEXT = 'AD';
const BADGE_COLOR = '#d93025';

type MuteStore = Record<string, TabMuteState>;

/** tabId → frameId → latest state from that frame. */
const frames = new Map<number, Map<number, AdPortMessage>>();
/** Per-tab serialization so overlapping reports can't race tabs.update calls. */
const chains = new Map<number, Promise<void>>();

async function loadStore(): Promise<MuteStore> {
  const raw = await browser.storage.session.get(KEYS.adMute);
  const store = raw[KEYS.adMute];
  return typeof store === 'object' && store !== null ? (store as MuteStore) : {};
}

async function saveTabState(tabId: number, state: TabMuteState | null): Promise<void> {
  const store = await loadStore();
  if (state && (state.session || state.mutedByUs)) store[tabId] = state;
  else delete store[tabId];
  await browser.storage.session.set({ [KEYS.adMute]: store });
}

async function reconcile(tabId: number): Promise<void> {
  const states = [...(frames.get(tabId)?.values() ?? [])];
  const showing = states.some((s) => s.active);
  const wantMute = states.some((s) => s.active && s.mute);

  let mutedInfo: MutedInfo;
  try {
    const tab = await browser.tabs.get(tabId);
    mutedInfo = tab.mutedInfo ?? { muted: false };
  } catch {
    // Tab is gone.
    frames.delete(tabId);
    await saveTabState(tabId, null);
    return;
  }

  const prev = (await loadStore())[tabId] ?? IDLE;
  const { action, state } = decideMute(prev, wantMute, mutedInfo, browser.runtime.id);
  if (action !== 'none') {
    await browser.tabs.update(tabId, { muted: action === 'mute' });
    console.info(`[wtv] tab ${tabId}: ${action}d for ad`);
  }
  await saveTabState(tabId, state);
  await browser.action.setBadgeText({ tabId, text: showing ? BADGE_TEXT : '' }).catch(() => undefined);
}

function schedule(tabId: number): void {
  const next = (chains.get(tabId) ?? Promise.resolve())
    .then(() => reconcile(tabId))
    .catch((err: unknown) => console.error(`[wtv] ad reconcile failed for tab ${tabId}:`, err));
  chains.set(tabId, next);
  void next.finally(() => {
    if (chains.get(tabId) === next) chains.delete(tabId);
  });
}

function setFrame(tabId: number, frameId: number, state: AdPortMessage | null): void {
  let tabFrames = frames.get(tabId);
  if (state && state.active) {
    if (!tabFrames) frames.set(tabId, (tabFrames = new Map()));
    tabFrames.set(frameId, state);
  } else if (tabFrames) {
    tabFrames.delete(frameId);
    if (tabFrames.size === 0) frames.delete(tabId);
  }
  schedule(tabId);
}

async function recoverAfterRestart(): Promise<void> {
  const store = await loadStore();
  for (const id of Object.keys(store)) {
    const tabId = Number(id);
    if (!frames.has(tabId)) schedule(tabId);
  }
}

/** Call synchronously at service-worker startup. */
export function startAdController(): void {
  void browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => undefined);

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AD_PORT) return;
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId ?? 0;
    if (tabId === undefined) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((raw: unknown) => {
      const msg = parseAdPortMessage(raw);
      if (msg) setFrame(tabId, frameId, msg);
    });
    port.onDisconnect.addListener(() => setFrame(tabId, frameId, null));
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    frames.delete(tabId);
    void saveTabState(tabId, null).catch(() => undefined);
  });

  setTimeout(() => {
    recoverAfterRestart().catch((err: unknown) => console.error('[wtv] ad state recovery failed:', err));
  }, RECOVERY_GRACE_MS);
}
