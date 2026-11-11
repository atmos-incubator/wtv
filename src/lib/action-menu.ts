/**
 * The toolbar icon's right-click menu: "Open side panel" (on the view it last showed).
 *
 * Created with the other context menus (playlist/menus.ts rebuilds them all after a
 * removeAll). sidePanel.open() needs a user gesture; a menu click is one, as long as it's
 * called straight from the click, before anything is awaited.
 */
import { browser } from 'wxt/browser';

export const OPEN_SIDE_PANEL = 'wtv-action:side-panel';

export const ACTION_MENU_ITEMS: Parameters<typeof browser.contextMenus.create>[0][] = [
  { id: OPEN_SIDE_PANEL, title: 'Open side panel', contexts: ['action'] },
];

/** Call synchronously at service-worker startup. */
export function startActionMenu(): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== OPEN_SIDE_PANEL || tab?.windowId === undefined) return;
    browser.sidePanel
      .open({ windowId: tab.windowId })
      .catch((err: unknown) => console.error('[wtv] could not open the side panel:', err));
  });
}
