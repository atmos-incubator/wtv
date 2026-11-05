import { browser } from 'wxt/browser';
import { browserAreas } from '../lib/browser-storage';
import { runMigrations, type InstallDetails } from '../lib/migrate';
import { BUNDLED_SITES } from '../lib/sites/bundled';
import { pruneStoredOverrides } from '../lib/sites/override-store';

async function handleInstalled(details: InstallDetails): Promise<void> {
  const areas = browserAreas();
  const report = await runMigrations(areas, details);
  console.info('[wtv] storage migration:', report);

  const removed = await pruneStoredOverrides(areas.local, BUNDLED_SITES);
  if (removed.length > 0) console.info('[wtv] superseded selector overrides removed:', removed);
}

export default defineBackground(() => {
  // Listeners must be registered synchronously at startup (MV3 service worker).
  browser.runtime.onInstalled.addListener((details) => {
    handleInstalled(details).catch((err: unknown) => {
      console.error('[wtv] onInstalled handling failed:', err);
    });
  });
});
