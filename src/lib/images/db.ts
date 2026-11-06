/**
 * Image library storage: IndexedDB in the extension origin (options page + overlay
 * iframe). Metadata and blobs are separate stores so listing the library never loads
 * image data.
 */
import type { ImageMeta } from './library';

const DB_NAME = 'wtv-images';
const DB_VERSION = 1;
const META = 'meta';
const BLOBS = 'blobs';
const KV = 'kv';

export const KV_FOLDER_HANDLE = 'folderHandle';
export const KV_IMPORT_SUMMARY = 'importSummary';

export interface ImportSummary {
  folderName: string;
  importedAt: number;
  imported: number;
  /** Files with unsupported extensions, or too large. */
  skippedFiles: number;
  /** Folders nested deeper than the layout allows. */
  skippedFolders: string[];
}

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

export function openImageDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export async function listImages(): Promise<ImageMeta[]> {
  const db = await openImageDb();
  return request(db.transaction(META).objectStore(META).getAll() as IDBRequest<ImageMeta[]>);
}

export async function getImageBlob(id: string): Promise<Blob | undefined> {
  const db = await openImageDb();
  return request(db.transaction(BLOBS).objectStore(BLOBS).get(id) as IDBRequest<Blob | undefined>);
}

/** Atomically replace the whole library. */
export async function replaceLibrary(entries: readonly { meta: ImageMeta; blob: Blob }[]): Promise<void> {
  const db = await openImageDb();
  const tx = db.transaction([META, BLOBS], 'readwrite');
  const meta = tx.objectStore(META);
  const blobs = tx.objectStore(BLOBS);
  meta.clear();
  blobs.clear();
  for (const { meta: m, blob } of entries) {
    meta.put(m);
    blobs.put(blob, m.id);
  }
  await done(tx);
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  const db = await openImageDb();
  return request(db.transaction(KV).objectStore(KV).get(key) as IDBRequest<T | undefined>);
}

export async function setKv(key: string, value: unknown): Promise<void> {
  const db = await openImageDb();
  const tx = db.transaction(KV, 'readwrite');
  tx.objectStore(KV).put(value, key);
  await done(tx);
}

export async function deleteKv(key: string): Promise<void> {
  const db = await openImageDb();
  const tx = db.transaction(KV, 'readwrite');
  tx.objectStore(KV).delete(key);
  await done(tx);
}
