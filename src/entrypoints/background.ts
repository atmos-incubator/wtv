import { browser } from 'wxt/browser';
import { startAdController } from '../lib/ads/controller';
import { browserAreas } from '../lib/browser-storage';
import { injectIntoMatchingTabs, syncContentScripts } from '../lib/injection';
import { runMigrations, type InstallDetails } from '../lib/migrate';
import { BUNDLED_SITES } from '../lib/sites/bundled';
import { pruneStoredOverrides } from '../lib/sites/override-store';
import { startViewController } from '../lib/view/controller';

async function handleInstalled(details: InstallDetails): Promise<void> {
  const areas = browserAreas();
  const report = await runMigrations(areas, details);
  console.info('[wtv] storage migration:', report);

  const removed = await pruneStoredOverrides(areas.local, BUNDLED_SITES);
  if (removed.length > 0) console.info('[wtv] superseded selector overrides removed:', removed);
}

/** Serialize registration updates so overlapping permission events can't race. */
let syncChain: Promise<unknown> = Promise.resolve();
function queueSync(): Promise<unknown> {
  syncChain = syncChain
    .then(syncContentScripts)
    .then((matches) => console.info('[wtv] content scripts registered for:', matches))
    .catch((err: unknown) => console.error('[wtv] content script registration failed:', err));
  return syncChain;
}

export default defineBackground(() => {
  // Listeners must be registered synchronously at startup (MV3 service worker).
  browser.runtime.onInstalled.addListener((details) => {
    handleInstalled(details).catch((err: unknown) => {
      console.error('[wtv] onInstalled handling failed:', err);
    });
    void queueSync();
  });

  browser.runtime.onStartup.addListener(() => {
    void queueSync();
  });

  browser.permissions.onAdded.addListener((permissions) => {
    void queueSync().then(() => injectIntoMatchingTabs(permissions.origins ?? []));
  });

  browser.permissions.onRemoved.addListener(() => {
    void queueSync();
  });

  startAdController();
  startViewController();
});
