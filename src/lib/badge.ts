/**
 * Toolbar badge, per tab. Background only. One owner, so the ad controller and the
 * health check can't clear each other's badge.
 *
 *   AD  (red)     an ad is showing in this tab
 *   !   (orange)  this site's selectors may be broken (see health/)
 *
 * In memory: ad state is re-reported by frames after a worker restart, and the health
 * badge is re-evaluated on each page.
 */
import { browser } from 'wxt/browser';

interface TabBadge {
  ad: boolean;
  broken: boolean;
}

const AD = { text: 'AD', color: '#d93025', title: 'Wtv: ad showing' };
const BROKEN = { text: '!', color: '#e8710a', title: 'Wtv: this site’s selectors may be broken. Open Wtv for details.' };

const tabs = new Map<number, TabBadge>();

function render(tabId: number, state: TabBadge): void {
  const look = state.ad ? AD : state.broken ? BROKEN : null;
  const ignore = () => undefined; // Tab closed meanwhile.
  void browser.action.setBadgeText({ tabId, text: look?.text ?? '' }).catch(ignore);
  if (look) void browser.action.setBadgeBackgroundColor({ tabId, color: look.color }).catch(ignore);
  void browser.action.setTitle({ tabId, title: look?.title ?? browser.runtime.getManifest().name }).catch(ignore);
}

export function setTabBadge(tabId: number, patch: Partial<TabBadge>): void {
  const prev = tabs.get(tabId) ?? { ad: false, broken: false };
  const next = { ...prev, ...patch };
  if (next.ad === prev.ad && next.broken === prev.broken && tabs.has(tabId)) return;
  if (next.ad || next.broken) tabs.set(tabId, next);
  else tabs.delete(tabId);
  render(tabId, next);
}

/** Call synchronously at service-worker startup. */
export function startBadges(): void {
  browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
  // A new page gets its own health verdict.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && tabs.get(tabId)?.broken) setTabBadge(tabId, { broken: false });
  });
}
