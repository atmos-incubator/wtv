/**
 * Dev builds only (background): screenshots for the snapshot button.
 *
 * captureVisibleTab needs activeTab or <all_urls>; host permissions for the site aren't
 * enough. A click inside the page doesn't grant activeTab, but clicking the toolbar icon
 * once on that tab does (until it navigates to another site).
 */
import { browser } from 'wxt/browser';
import { DEV_SCREENSHOT, type ScreenshotReply } from './messages';

export function startDevScreenshots(): void {
  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (r: ScreenshotReply) => void) => {
    if ((msg as { type?: unknown } | null)?.type !== DEV_SCREENSHOT) return undefined;
    const windowId = sender.tab?.windowId;
    if (windowId === undefined) {
      sendResponse({ ok: false, error: 'not from a tab' });
      return undefined;
    }
    browser.tabs
      .captureVisibleTab(windowId, { format: 'png' })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  });
}
