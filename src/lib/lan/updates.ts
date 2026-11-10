/**
 * LAN builds only (`npm run lan:build`; see scripts/lan/): pick up a newer copy of Wtv once it
 * has been synced onto disk.
 *
 * An unpacked extension runs what was on disk when it loaded. On the second computer the sync
 * script replaces the folder's files, `build.json` last. Here, once a minute (and at start),
 * the background reads `build.json` from disk and, when it names another build than the one
 * running (baked in at build time), reloads Wtv. The folder doesn't move, so the extension ID,
 * and with it the playlists and settings, stay.
 *
 * Not while a playlist plays or one of Wtv's own pages is open: the reload would stop the one
 * and close the other (unsaved playlist edits). It waits for them; Reload on
 * chrome://extensions works any time.
 */
import { browser } from 'wxt/browser';
import { KEYS } from '../storage';
import { BUILD_FILE, parseBuildInfo, shouldReload, type BuildInfo, type ReloadTried } from './build-info';

/** Replaced at build time (wxt.config.ts, vite `define`). */
declare const __WTV_BUILD__: string;

const ALARM = 'wtv.lan.update';
const TRIED_KEY = 'wtv.lan.reloadTried';

interface WindowClient {
  frameType: string;
  url: string;
}
const sw = self as unknown as { clients: { matchAll(o: { type: 'window' }): Promise<readonly WindowClient[]> } };

async function onDisk(): Promise<BuildInfo | null> {
  try {
    const res = await fetch(new URL(`/${BUILD_FILE}`, self.location.href), { cache: 'no-store' });
    return res.ok ? parseBuildInfo(await res.json()) : null;
  } catch {
    return null;
  }
}

async function loadTried(): Promise<ReloadTried | null> {
  const raw = (await browser.storage.local.get(TRIED_KEY))[TRIED_KEY] as Partial<ReloadTried> | undefined;
  return typeof raw?.running === 'string' && typeof raw.disk === 'string' ? { running: raw.running, disk: raw.disk } : null;
}

/** Why not now, or null. */
async function busy(): Promise<string | null> {
  const runner = (await browser.storage.session.get(KEYS.runner))[KEYS.runner] as Record<string, { phase?: string }> | undefined;
  if (runner && Object.values(runner).some((s) => s?.phase !== 'detached')) return 'a playlist is playing';
  const pages = await sw.clients.matchAll({ type: 'window' });
  const open = pages.find((c) => c.frameType === 'top-level');
  if (open) return `${new URL(open.url).pathname.slice(1)} is open`;
  return null;
}

let checking = false;
let lastWait = '';

async function check(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const running = __WTV_BUILD__;
    const disk = await onDisk();
    if (!disk || !shouldReload(running, disk, await loadTried())) return;
    const why = await busy();
    if (why) {
      const note = `[wtv] update ${disk.id} waits: ${why}`;
      if (note !== lastWait) console.info(note);
      lastWait = note;
      return;
    }
    console.info(`[wtv] reloading: ${running} → ${disk.id}`);
    await browser.storage.local.set({ [TRIED_KEY]: { running, disk: disk.id } satisfies ReloadTried });
    browser.runtime.reload();
  } catch (err) {
    console.warn('[wtv] update check failed:', err);
  } finally {
    checking = false;
  }
}

export function startLanUpdates(): void {
  console.info(`[wtv] LAN build ${__WTV_BUILD__}`);
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void check();
  });
  void browser.alarms.get(ALARM).then((alarm) => {
    if (!alarm) return browser.alarms.create(ALARM, { periodInMinutes: 1 });
  });
  void check();
}
