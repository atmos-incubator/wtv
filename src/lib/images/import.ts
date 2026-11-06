/**
 * Import a picked folder into the library (extension pages only: File System Access
 * API). Reads the layout described in library.ts, then atomically replaces the stored
 * library. Files are disk-backed Blobs, so a big folder doesn't load into memory.
 */
import { parseImageFilename } from './filename';
import { classifyPath, type ImageMeta } from './library';
import { KV_FOLDER_HANDLE, KV_IMPORT_SUMMARY, replaceLibrary, setKv, type ImportSummary } from './db';

/** Skip anything bigger than this (a stray movie file, say). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

type Entry = FileSystemDirectoryHandle | FileSystemFileHandle;

async function* walk(
  dir: FileSystemDirectoryHandle,
  dirs: string[],
  skippedFolders: string[],
): AsyncGenerator<{ dirs: string[]; handle: FileSystemFileHandle }> {
  for await (const entry of dir.values() as AsyncIterable<Entry>) {
    if (entry.name.startsWith('.')) continue;
    if (entry.kind === 'file') {
      yield { dirs, handle: entry };
    } else {
      const next = [...dirs, entry.name];
      // Only descend where something could be placed; anything deeper is reported.
      if (classifyPath(next) === null) skippedFolders.push(next.join('/'));
      else yield* walk(entry, next, skippedFolders);
    }
  }
}

export async function importFolder(root: FileSystemDirectoryHandle): Promise<ImportSummary> {
  const entries: { meta: ImageMeta; blob: Blob }[] = [];
  const skippedFolders: string[] = [];
  let skippedFiles = 0;

  for await (const { dirs, handle } of walk(root, [], skippedFolders)) {
    const parsed = parseImageFilename(handle.name);
    const placement = classifyPath(dirs);
    if (!parsed || !placement) {
      skippedFiles++;
      continue;
    }
    const file = await handle.getFile();
    if (file.size > MAX_FILE_BYTES) {
      skippedFiles++;
      continue;
    }
    entries.push({
      meta: {
        id: [...dirs, handle.name].join('/'),
        domain: placement.domain,
        folder: placement.folder,
        stem: parsed.stem,
        durationMs: parsed.durationMs,
        kind: parsed.kind,
        mime: parsed.mime,
      },
      blob: file,
    });
  }

  await replaceLibrary(entries);
  const summary: ImportSummary = {
    folderName: root.name,
    importedAt: Date.now(),
    imported: entries.length,
    skippedFiles,
    skippedFolders,
  };
  await setKv(KV_IMPORT_SUMMARY, summary);
  await setKv(KV_FOLDER_HANDLE, root);
  return summary;
}

/** Re-read access to a stored folder handle. Must run from a user gesture to prompt. */
export async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}
