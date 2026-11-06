/**
 * "Add to Wtv playlist ▸" context menu: one item per saved playlist, plus "New
 * playlist". Rebuilt on install / startup and whenever the playlists change. Menus
 * persist in the browser across service-worker restarts, so nothing is rebuilt on wake.
 *
 * A link's target is added (with no title); anywhere else, the page itself (with the
 * tab's title).
 */
import { browser } from 'wxt/browser';
import { browserAreas } from '../browser-storage';
import { isWebUrl } from '../permissions';
import { KEYS } from '../storage';
import { addToPlaylist, listPlaylists } from './store';

const ROOT = 'wtv-add';
const NEW = 'wtv-add:new';
const PREFIX = 'wtv-add:pl:';
const CONTEXTS = ['page', 'link', 'video', 'audio'] as const;
/** Chrome caps a submenu at 1000 items; keep it usable well before that. */
const MAX_ITEMS = 50;

let chain: Promise<unknown> = Promise.resolve();

function create(props: Parameters<typeof browser.contextMenus.create>[0]): Promise<void> {
  return new Promise((resolve) => {
    browser.contextMenus.create(props, () => {
      // Read lastError so a duplicate id during a racing rebuild doesn't log as unchecked.
      void browser.runtime.lastError;
      resolve();
    });
  });
}

async function rebuild(): Promise<void> {
  await browser.contextMenus.removeAll();
  const playlists = await listPlaylists(browserAreas().local);
  await create({ id: ROOT, title: 'Add to Wtv playlist', contexts: [...CONTEXTS] });
  for (const p of playlists.slice(0, MAX_ITEMS)) {
    await create({ id: `${PREFIX}${p.id}`, parentId: ROOT, title: p.name, contexts: [...CONTEXTS] });
  }
  if (playlists.length > 0) {
    await create({ id: 'wtv-add:sep', parentId: ROOT, type: 'separator', contexts: [...CONTEXTS] });
  }
  await create({ id: NEW, parentId: ROOT, title: 'New playlist', contexts: [...CONTEXTS] });
}

export function rebuildPlaylistMenus(): void {
  chain = chain.then(rebuild).catch((err: unknown) => console.error('[wtv] playlist menu rebuild failed:', err));
}

/** Call synchronously at service-worker startup. */
export function startPlaylistMenus(): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.playlists in changes) rebuildPlaylistMenus();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId);
    if (id !== NEW && !id.startsWith(PREFIX)) return;
    const url = info.linkUrl ?? info.pageUrl;
    if (!isWebUrl(url)) return;
    const title = info.linkUrl ? null : (tab?.title ?? null);
    const playlistId = id === NEW ? null : id.slice(PREFIX.length);
    addToPlaylist(browserAreas().local, playlistId, url, title)
      .then((p) => console.info(`[wtv] added ${url} to "${p.name}"`))
      .catch((err: unknown) => console.error('[wtv] add to playlist failed:', err));
  });
}
