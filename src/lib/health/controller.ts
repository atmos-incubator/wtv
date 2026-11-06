/**
 * Background side of the in-extension health check: keeps per-site streaks in
 * storage.local and sets the "!" badge on the reporting tab when a role is broken.
 * Streaks reset whenever a site's selectors change (an override saved or reset, or a
 * new release), since the old verdict no longer applies.
 */
import { browser } from 'wxt/browser';
import { setTabBadge } from '../badge';
import { KEYS } from '../storage';
import { applyReport, brokenRoles, parseHealthReport, parseHealthStore, withoutSites, type HealthStore } from './health';

let chain: Promise<unknown> = Promise.resolve();
function serial(task: () => Promise<void>): void {
  chain = chain.then(task).catch((err: unknown) => console.error('[wtv] site health:', err));
}

async function load(): Promise<HealthStore> {
  return parseHealthStore((await browser.storage.local.get(KEYS.siteHealth))[KEYS.siteHealth]);
}

async function save(store: HealthStore): Promise<void> {
  await browser.storage.local.set({ [KEYS.siteHealth]: store });
}

/** After an install / update: bundled selectors may have changed. */
export async function resetSiteHealth(): Promise<void> {
  await browser.storage.local.remove(KEYS.siteHealth);
}

function changedSites(oldValue: unknown, newValue: unknown): string[] {
  const a = (oldValue ?? {}) as Record<string, unknown>;
  const b = (newValue ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (id) => JSON.stringify(a[id]) !== JSON.stringify(b[id]),
  );
}

/** Call synchronously at service-worker startup. */
export function startHealthController(): void {
  browser.runtime.onMessage.addListener((raw: unknown, sender) => {
    const report = parseHealthReport(raw);
    const tabId = sender.tab?.id;
    if (!report || tabId === undefined) return undefined;
    serial(async () => {
      const store = applyReport(await load(), report, Date.now());
      await save(store);
      const broken = brokenRoles(store[report.siteId]);
      if (broken.length > 0) console.warn(`[wtv] ${report.siteId}: selectors may be broken for`, broken);
      setTabBadge(tabId, { broken: broken.length > 0 });
    });
    return undefined;
  });

  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[KEYS.siteOverrides];
    if (area !== 'local' || !change) return;
    const sites = changedSites(change.oldValue, change.newValue);
    if (sites.length === 0) return;
    serial(async () => save(withoutSites(await load(), sites)));
  });
}
