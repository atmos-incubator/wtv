/**
 * Side panel: two views, Playlists (the explorer: browse and start playlists while
 * watching) and Fix selectors (the selector tools). The popup picks one when it opens
 * the panel; otherwise it shows the last one used.
 */
import './style.css';
import { browser } from 'wxt/browser';
import {
  SIDE_PANEL_VIEWS,
  getSidePanelView,
  onSidePanelViewRequest,
  setSidePanelView,
  type SidePanelView,
} from '../../lib/sidepanel-view';
import { hideExplorer, showExplorer } from './explorer';
import { hideSelectors, showSelectors } from './selectors';

const TITLES: Record<SidePanelView, string> = { playlists: 'Wtv playlists', selectors: 'Wtv selectors' };
const tab = (v: SidePanelView) => document.getElementById(`tab-${v}`) as HTMLButtonElement;
const pane = (v: SidePanelView) => document.getElementById(v) as HTMLElement;

let windowId: number | null = null;

function show(view: SidePanelView): void {
  setSidePanelView(view);
  for (const v of SIDE_PANEL_VIEWS) {
    const on = v === view;
    tab(v).setAttribute('aria-selected', String(on));
    tab(v).tabIndex = on ? 0 : -1;
    pane(v).hidden = !on;
  }
  document.title = TITLES[view];
  if (view === 'playlists') {
    hideSelectors();
    showExplorer(windowId);
  } else {
    hideExplorer();
    showSelectors();
  }
}

for (const [i, v] of SIDE_PANEL_VIEWS.entries()) {
  tab(v).addEventListener('click', () => show(v));
  tab(v).addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = SIDE_PANEL_VIEWS[(i + step + SIDE_PANEL_VIEWS.length) % SIDE_PANEL_VIEWS.length]!;
    show(next);
    tab(next).focus();
  });
}

void (async () => {
  windowId = (await browser.windows.getCurrent().catch(() => null))?.id ?? null;
  if (windowId !== null) onSidePanelViewRequest(windowId, show);
  show(getSidePanelView());
})();
