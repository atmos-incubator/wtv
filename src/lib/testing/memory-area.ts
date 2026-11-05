import type { KVArea } from '../storage';

export interface MemoryArea extends KVArea {
  dump(): Record<string, unknown>;
}

/** In-memory KVArea with chrome.storage semantics (values are structured-cloned). */
export function createMemoryArea(initial: Record<string, unknown> = {}): MemoryArea {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  return {
    async get(keys) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    dump() {
      return structuredClone(Object.fromEntries(data));
    },
  };
}
