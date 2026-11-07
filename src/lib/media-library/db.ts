/**
 * Media library storage: IndexedDB in the extension origin, beside the image library.
 * Written by the background (runner reports, thumbnail fetches), read by the playlists
 * page. Records and thumbnail blobs are separate stores, so listing never loads images.
 */
import { mergeRecord, parseRecord, type MediaPatch, type MediaRecord } from './record';

const DB_NAME = 'wtv-media';
const DB_VERSION = 1;
const RECORDS = 'records';
const THUMBS = 'thumbs';

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(THUMBS)) db.createObjectStore(THUMBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export async function getRecord(key: string): Promise<MediaRecord | null> {
  const db = await openDb();
  return parseRecord(await request(db.transaction(RECORDS).objectStore(RECORDS).get(key)));
}

export async function listRecords(): Promise<Map<string, MediaRecord>> {
  const db = await openDb();
  const all = (await request(db.transaction(RECORDS).objectStore(RECORDS).getAll())) as unknown[];
  const out = new Map<string, MediaRecord>();
  for (const raw of all) {
    const r = parseRecord(raw);
    if (r) out.set(r.key, r);
  }
  return out;
}

/** Read, merge and write in one transaction, so concurrent patches can't lose fields. */
export async function patchRecord(patch: MediaPatch, now = Date.now()): Promise<MediaRecord | null> {
  const db = await openDb();
  const tx = db.transaction(RECORDS, 'readwrite');
  const store = tx.objectStore(RECORDS);
  let result: MediaRecord | null = null;
  const key = mergeRecord(null, patch, now)?.key;
  if (!key) return null;
  const get = store.get(key);
  get.onsuccess = () => {
    result = mergeRecord(parseRecord(get.result), patch, now);
    if (result) store.put(result);
  };
  await done(tx);
  return result;
}

export async function putThumbnail(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(THUMBS, 'readwrite');
  tx.objectStore(THUMBS).put(blob, key);
  await done(tx);
}

export async function getThumbnail(key: string): Promise<Blob | null> {
  const db = await openDb();
  const blob: unknown = await request(db.transaction(THUMBS).objectStore(THUMBS).get(key));
  return blob instanceof Blob ? blob : null;
}
