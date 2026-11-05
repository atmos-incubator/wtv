import { browser } from 'wxt/browser';
import type { KVArea, StorageAreas } from './storage';

interface ChromeArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function wrap(area: ChromeArea): KVArea {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

/** Real chrome.storage areas. Only call from extension contexts. */
export function browserAreas(): StorageAreas {
  return {
    local: wrap(browser.storage.local as unknown as ChromeArea),
    sync: wrap(browser.storage.sync as unknown as ChromeArea),
    session: wrap(browser.storage.session as unknown as ChromeArea),
  };
}
