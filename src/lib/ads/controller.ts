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
import { attributeMute, decideMute, IDLE, isOurMute, type MutedInfo, type TabMuteState } from './mute';
import { AD_PORT, parseAdPortMessage, type AdPortMessage } from './protocol';

const RECOVERY_GRACE_MS = 5000;
const BADGE_TEXT = 'AD';
const BADGE_COLOR = '#d93025';

type MuteStore = Record<string, TabMuteState>;
type UserMuteStore = Record<string, true>;

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

async function loadUserMutes(): Promise<UserMuteStore> {
  const raw = await browser.storage.session.get(KEYS.userMute);
  const store = raw[KEYS.userMute];
  return typeof store === 'object' && store !== null ? (store as UserMuteStore) : {};
}

async function setUserMute(tabId: number, on: boolean): Promise<void> {
  const store = await loadUserMutes();
  if (on) store[tabId] = true;
  else delete store[tabId];
  await browser.storage.session.set({ [KEYS.userMute]: store });
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
    await setUserMute(tabId, false);
    return;
  }

  // A mute from Wtv's own mute command is the user's. Once the tab is no longer muted
  // by us (they unmuted, from Chrome's tab strip or anywhere else), forget it.
  let userMuted = Boolean((await loadUserMutes())[tabId]);
  if (userMuted && !isOurMute(mutedInfo, browser.runtime.id)) {
    userMuted = false;
    await setUserMute(tabId, false);
  }
  mutedInfo = attributeMute(mutedInfo, userMuted, browser.runtime.id);

  const prev = (await loadStore())[tabId] ?? IDLE;
  const { action, state } = decideMute(prev, wantMute, mutedInfo, browser.runtime.id);
  if (action !== 'none') {
    await browser.tabs.update(tabId, { muted: action === 'mute' });
    console.info(`[wtv] tab ${tabId}: ${action}d for ad`);
  }
  await saveTabState(tabId, state);
  await browser.action.setBadgeText({ tabId, text: showing ? BADGE_TEXT : '' }).catch(() => undefined);
}

function enqueue(tabId: number, task: () => Promise<void>, what: string): Promise<void> {
  const next = (chains.get(tabId) ?? Promise.resolve())
    .then(task)
    .catch((err: unknown) => console.error(`[wtv] ${what} failed for tab ${tabId}:`, err));
  chains.set(tabId, next);
  void next.finally(() => {
    if (chains.get(tabId) === next) chains.delete(tabId);
  });
  return next;
}

function schedule(tabId: number): void {
  void enqueue(tabId, () => reconcile(tabId), 'ad reconcile');
}

/**
 * Wtv's mute command (keyboard shortcut). Serialized with ad reconciles. Unmuting during
 * an ad counts as the user taking over (decideMute gives up ownership); muting is
 * remembered as theirs, so an ad ending won't unmute it.
 */
export function toggleTabMute(tabId: number): Promise<void> {
  return enqueue(
    tabId,
    async () => {
      const tab = await browser.tabs.get(tabId);
      const muted = !(tab.mutedInfo?.muted ?? false);
      await setUserMute(tabId, muted);
      await browser.tabs.update(tabId, { muted });
      if (frames.has(tabId)) await reconcile(tabId);
    },
    'mute toggle',
  );
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
    void setUserMute(tabId, false).catch(() => undefined);
  });

  setTimeout(() => {
    recoverAfterRestart().catch((err: unknown) => console.error('[wtv] ad state recovery failed:', err));
  }, RECOVERY_GRACE_MS);
}
