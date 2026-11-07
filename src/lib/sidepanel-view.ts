/**
 * Which view the side panel shows: the playlist explorer or the selector tools.
 *
 * Kept in the extension origin's localStorage, so the popup can pick one right before it
 * opens the panel (sidePanel.open() must run synchronously in the click). A panel that's
 * already open in that window follows the request through the `storage` event; panels in
 * other windows ignore it.
 */
export const SIDE_PANEL_VIEWS = ['playlists', 'selectors'] as const;
export type SidePanelView = (typeof SIDE_PANEL_VIEWS)[number];

/** The view a panel opens with: the last one chosen. */
const KEY = 'wtv.sidepanel.view';
/** `{ view, windowId, at }`: the popup asking a window's panel for a view. */
const REQUEST_KEY = 'wtv.sidepanel.request';

const isView = (v: unknown): v is SidePanelView => (SIDE_PANEL_VIEWS as readonly unknown[]).includes(v);

export function getSidePanelView(): SidePanelView {
  try {
    const v = localStorage.getItem(KEY);
    return isView(v) ? v : 'playlists';
  } catch {
    return 'playlists';
  }
}

/** The panel's own view tabs. */
export function setSidePanelView(view: SidePanelView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // Storage blocked: the panel shows its default next time.
  }
}

/** From the popup, just before it opens the panel in `windowId`. */
export function requestSidePanelView(view: SidePanelView, windowId: number): void {
  setSidePanelView(view);
  try {
    localStorage.setItem(REQUEST_KEY, JSON.stringify({ view, windowId, at: Date.now() }));
  } catch {
    // As above.
  }
}

export function onSidePanelViewRequest(windowId: number, listener: (view: SidePanelView) => void): void {
  window.addEventListener('storage', (e) => {
    if (e.key !== REQUEST_KEY || !e.newValue) return;
    try {
      const req = JSON.parse(e.newValue) as { view?: unknown; windowId?: unknown };
      if (req.windowId === windowId && isView(req.view)) listener(req.view);
    } catch {
      // Not ours.
    }
  });
}
