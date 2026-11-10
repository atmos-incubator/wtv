/**
 * Background side of maximize, TV mode, play / pause and mute: keyboard commands, popup
 * buttons and content-script requests all land here.
 *
 * Maximize state lives in the pages (each frame knows what it maximized), so it can't go
 * stale across navigations or worker restarts. The background reads it fresh from every
 * frame with one scripting.executeScript call (FrameCandidate per frame id), picks a
 * frame (elect.ts), and messages that frame.
 *
 * TV mode = fullscreen window + maximized video, per tab, in storage.session. A
 * fullscreen *window* (not element fullscreen) needs no user gesture and survives
 * navigation, so each new page in a TV-mode tab just re-maximizes once its video is up
 * (VIEW_READY). Leaving the window fullscreen some other way ends TV mode.
 *
 * Maximize kept: the user maximized in a tab (shortcut, popup, double-click), so while a
 * playlist plays there its next entries maximize too, the same way, until the user
 * restores (or Esc). A page losing its maximized video doesn't count as restoring.
 *
 * Skip back / forward (arrow keys over the video): to the frame play / pause goes to.
 */
import { browser } from 'wxt/browser';
import { toggleTabMute } from '../ads/controller';
import { KEYS } from '../storage';
import { electFrame, type FrameReport } from './elect';
import {
  VIEW_APPLY,
  VIEW_COMMAND,
  VIEW_GLOBAL,
  VIEW_READY,
  VIEW_STATE,
  VIEW_VERIFY,
  newViewToken,
  parseFrameCandidate,
  parseViewRequest,
  type ViewApply,
  type ViewOp,
  type ViewState,
} from './messages';

type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen';

interface TvState {
  /** Window state to go back to when TV mode ends. */
  previous: WindowState;
}

type TvStore = Record<string, TvState>;

/** Arrow keys move this far through the video. */
export const SKIP_S = 10;
/** Wait for the new page's frames to settle before re-maximizing in TV mode. */
const READY_DELAY_MS = 400;
/** Ignore window bound changes this soon after we went fullscreen (macOS animates it). */
const FULLSCREEN_SETTLE_MS = 2000;

export const COMMANDS = {
  playPause: 'play-pause',
  maximize: 'maximize',
  tv: 'tv-mode',
  mute: 'mute',
} as const;

/** Current maximize token per tab; parent frames verify a child's request against it. */
const tokens = new Map<number, string>();
const readyTimers = new Map<number, ReturnType<typeof setTimeout>>();
let fullscreenAt = 0;

async function loadTv(): Promise<TvStore> {
  const raw = await browser.storage.session.get(KEYS.tvMode);
  const store = raw[KEYS.tvMode];
  return typeof store === 'object' && store !== null ? (store as TvStore) : {};
}

async function saveTv(store: TvStore): Promise<void> {
  await browser.storage.session.set({ [KEYS.tvMode]: store });
}

async function loadKept(): Promise<Record<string, true>> {
  const raw = (await browser.storage.session.get(KEYS.maximizeKept))[KEYS.maximizeKept];
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, true>) : {};
}

async function keepMaximized(tabId: number, on: boolean): Promise<void> {
  const kept = await loadKept();
  if (Boolean(kept[tabId]) === on) return;
  if (on) kept[tabId] = true;
  else delete kept[tabId];
  await browser.storage.session.set({ [KEYS.maximizeKept]: kept });
}

/** A playlist is playing in the tab (the runner's store: it imports us, so not its code). */
async function playlistIn(tabId: number): Promise<boolean> {
  const raw = (await browser.storage.session.get(KEYS.runner))[KEYS.runner] as Record<string, { phase?: string }> | undefined;
  const state = raw?.[tabId];
  return state !== undefined && state.phase !== 'detached';
}

/** For the playlist runner: the tab is in TV mode, or kept maximized. */
export async function watchingFullView(tabId: number): Promise<boolean> {
  const [tv, kept] = await Promise.all([loadTv(), loadKept()]);
  return Boolean(tv[tabId] || kept[tabId]);
}

/** Runs in each frame's isolated world. Must be self-contained (it's serialized). */
function readCandidate(key: string): unknown {
  const api = (globalThis as unknown as Record<symbol, { candidate?: () => unknown } | undefined>)[Symbol.for(key)];
  return api?.candidate?.() ?? null;
}

async function queryFrames(tabId: number): Promise<FrameReport[]> {
  const reports: FrameReport[] = [];
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: readCandidate,
      args: [VIEW_GLOBAL],
    });
    for (const r of results) {
      const candidate = parseFrameCandidate(r.result);
      if (candidate) reports.push({ frameId: r.frameId, candidate });
    }
  } catch {
    // No access to the top frame (e.g. a "Just this tab" grant that has lapsed). Ask the
    // top frame directly in case the agent is still there.
    try {
      const candidate = parseFrameCandidate(
        await browser.tabs.sendMessage(tabId, { type: VIEW_APPLY, op: 'candidate' } satisfies ViewApply, { frameId: 0 }),
      );
      if (candidate) reports.push({ frameId: 0, candidate });
    } catch {
      // Nothing running in this tab.
    }
  }
  return reports;
}

async function broadcast(tabId: number, msg: ViewApply): Promise<void> {
  // No frameId: every frame gets it.
  await browser.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

async function maximize(tabId: number, frames?: FrameReport[]): Promise<boolean> {
  const reports = frames ?? (await queryFrames(tabId));
  if (reports.some((f) => f.candidate.maximized)) return true;
  const frameId = electFrame(reports, 'maximize');
  if (frameId === null) return false;
  const token = newViewToken();
  tokens.set(tabId, token);
  const msg: ViewApply = { type: VIEW_APPLY, op: 'maximize', token };
  try {
    return (await browser.tabs.sendMessage(tabId, msg, { frameId })) === true;
  } catch {
    return false;
  }
}

async function restore(tabId: number): Promise<void> {
  tokens.delete(tabId);
  await broadcast(tabId, { type: VIEW_APPLY, op: 'restore' });
}

/** The user's maximize / restore: kept (or not) for a playlist's next entries. */
async function toggleMaximize(tabId: number): Promise<void> {
  const frames = await queryFrames(tabId);
  if (frames.some((f) => f.candidate.maximized)) {
    await keepMaximized(tabId, false);
    await restore(tabId);
  } else if (await maximize(tabId, frames)) {
    await keepMaximized(tabId, true);
  }
}

/** To the frame playing (or holding) the show. */
async function toPlaybackFrame(tabId: number, msg: ViewApply): Promise<void> {
  const frameId = electFrame(await queryFrames(tabId), 'playback');
  if (frameId === null) return;
  await browser.tabs.sendMessage(tabId, msg, { frameId }).catch(() => undefined);
}

async function enterTv(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  const win = await browser.windows.get(tab.windowId);
  const store = await loadTv();
  store[tabId] ??= { previous: (win.state ?? 'normal') as WindowState };
  await saveTv(store);
  if (win.state !== 'fullscreen') {
    fullscreenAt = Date.now();
    await browser.windows.update(tab.windowId, { state: 'fullscreen' });
  }
  await maximize(tabId);
}

/** `restoreWindow: false` when the user already left fullscreen themselves. */
async function exitTv(tabId: number, restoreWindow = true): Promise<void> {
  const store = await loadTv();
  const tv = store[tabId];
  if (!tv) return;
  delete store[tabId];
  await saveTv(store);
  await keepMaximized(tabId, false);
  await restore(tabId);
  if (!restoreWindow || tv.previous === 'fullscreen' || tv.previous === 'locked-fullscreen') return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const state = tv.previous === 'minimized' ? 'normal' : tv.previous;
  await browser.windows.update(tab.windowId, { state }).catch(() => undefined);
}

/** For the playlist runner: start a playlist in TV mode. */
export async function setTvMode(tabId: number, on: boolean): Promise<void> {
  if (on) await enterTv(tabId);
  else await exitTv(tabId);
}

async function toggleTv(tabId: number): Promise<void> {
  if ((await loadTv())[tabId]) await exitTv(tabId);
  else await enterTv(tabId);
}

async function viewState(tabId: number): Promise<ViewState> {
  const [frames, tv, kept] = await Promise.all([queryFrames(tabId), loadTv(), loadKept()]);
  return {
    maximized: frames.some((f) => f.candidate.maximized),
    canMaximize: frames.some((f) => f.candidate.video),
    tv: Boolean(tv[tabId]),
    maximizeKept: Boolean(kept[tabId]),
  };
}

async function runOp(tabId: number, op: ViewOp): Promise<void> {
  switch (op) {
    case 'toggle-maximize':
      return toggleMaximize(tabId);
    case 'restore':
      return restore(tabId);
    case 'escape':
      await keepMaximized(tabId, false);
      if ((await loadTv())[tabId]) return exitTv(tabId);
      return restore(tabId);
    case 'toggle-tv':
      return toggleTv(tabId);
    case 'play-pause':
      return toPlaybackFrame(tabId, { type: VIEW_APPLY, op: 'play-pause' });
    case 'skip-back':
    case 'skip-forward':
      return toPlaybackFrame(tabId, { type: VIEW_APPLY, op: 'skip', by: op === 'skip-back' ? -SKIP_S : SKIP_S });
    case 'mute':
      return toggleTabMute(tabId);
  }
}

/** A new page in the tab has its video up: maximize it again in TV mode, or kept maximized in a playlist. */
function onReady(tabId: number): void {
  void (async () => {
    const [tv, kept] = await Promise.all([loadTv(), loadKept()]);
    return Boolean(tv[tabId]) || (Boolean(kept[tabId]) && (await playlistIn(tabId)));
  })().then((again) => {
    if (!again) return;
    clearTimeout(readyTimers.get(tabId));
    readyTimers.set(
      tabId,
      setTimeout(() => {
        readyTimers.delete(tabId);
        void maximize(tabId).catch((err: unknown) => console.warn('[wtv] re-maximize failed:', err));
      }, READY_DELAY_MS),
    );
  });
}

function log(what: string) {
  return (err: unknown) => console.error(`[wtv] ${what} failed:`, err);
}

/** Call synchronously at service-worker startup. */
export function startViewController(): void {
  browser.commands.onCommand.addListener((command, tab) => {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    const op: ViewOp | null =
      command === COMMANDS.playPause
        ? 'play-pause'
        : command === COMMANDS.maximize
          ? 'toggle-maximize'
          : command === COMMANDS.tv
            ? 'toggle-tv'
            : command === COMMANDS.mute
              ? 'mute'
              : null;
    if (op) void runOp(tabId, op).catch(log(`command ${command}`));
  });

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (r: unknown) => void) => {
    const msg = parseViewRequest(raw);
    if (!msg) return undefined;
    // Content scripts act on their own tab; the popup names one.
    const senderTab = sender.tab?.id;
    const tabId = senderTab ?? (msg.type === VIEW_COMMAND || msg.type === VIEW_STATE ? msg.tabId : null);
    if (tabId === null || tabId === undefined) return undefined;

    switch (msg.type) {
      case VIEW_COMMAND:
        runOp(tabId, msg.op)
          .catch(log(`view ${msg.op}`))
          .then(() => viewState(tabId))
          .then(sendResponse, () => sendResponse(null));
        return true;
      case VIEW_STATE:
        viewState(tabId).then(sendResponse, () => sendResponse(null));
        return true;
      case VIEW_READY:
        onReady(tabId);
        return undefined;
      case VIEW_VERIFY:
        sendResponse(senderTab !== undefined && tokens.get(tabId) === msg.token);
        return undefined;
    }
    return undefined;
  });

  // TV mode ends if the window leaves fullscreen some other way (OS button, F11, ...).
  browser.windows.onBoundsChanged.addListener((win) => {
    if (win.id === undefined || win.state === 'fullscreen') return;
    if (Date.now() - fullscreenAt < FULLSCREEN_SETTLE_MS) return;
    void (async () => {
      const store = await loadTv();
      for (const id of Object.keys(store)) {
        const tab = await browser.tabs.get(Number(id)).catch(() => null);
        if (!tab || tab.windowId === win.id) await exitTv(Number(id), false);
      }
    })().catch(log('TV mode exit'));
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tokens.delete(tabId);
    clearTimeout(readyTimers.get(tabId));
    readyTimers.delete(tabId);
    void loadTv()
      .then(async (store) => {
        if (!store[tabId]) return;
        delete store[tabId];
        await saveTv(store);
      })
      .catch(() => undefined);
    void keepMaximized(tabId, false).catch(() => undefined);
  });
}
