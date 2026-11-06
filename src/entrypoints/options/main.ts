import './style.css';
import { BUNDLED_IMAGES } from '../../lib/images/bundled';
import {
  KV_FOLDER_HANDLE,
  KV_IMPORT_SUMMARY,
  deleteKv,
  getKv,
  listImages,
  replaceLibrary,
  type ImportSummary,
} from '../../lib/images/db';
import { ensureReadPermission, importFolder } from '../../lib/images/import';
import { resolveImages, type ImageMeta } from '../../lib/images/library';
import { DEFAULT_IMAGE_MS } from '../../lib/overlay/program';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLElement>('library-status');
const groups = $<HTMLUListElement>('groups');
const choose = $<HTMLButtonElement>('choose');
const refresh = $<HTMLButtonElement>('refresh');
const clear = $<HTMLButtonElement>('clear');
const testForm = $<HTMLFormElement>('test');
const testHost = $<HTMLInputElement>('test-host');
const testKeyword = $<HTMLInputElement>('test-keyword');
const testResult = $<HTMLUListElement>('test-result');

let library: ImageMeta[] = [];

function li(text: string, aside?: string, asideClass = 'count'): HTMLLIElement {
  const item = document.createElement('li');
  item.append(Object.assign(document.createElement('span'), { textContent: text }));
  if (aside) item.append(Object.assign(document.createElement('span'), { className: asideClass, textContent: aside }));
  return item;
}

function seconds(ms: number | null): string {
  return `${Math.round((ms ?? DEFAULT_IMAGE_MS) / 1000)}s`;
}

async function render(): Promise<void> {
  const [images, summary, handle] = await Promise.all([
    listImages(),
    getKv<ImportSummary>(KV_IMPORT_SUMMARY),
    getKv<FileSystemDirectoryHandle>(KV_FOLDER_HANDLE),
  ]);
  library = images;

  status.replaceChildren();
  if (!summary || images.length === 0) {
    status.append(
      Object.assign(document.createElement('p'), {
        textContent: `No folder imported. Using the ${BUNDLED_IMAGES.length} built-in cat pictures.`,
      }),
    );
  } else {
    const when = new Date(summary.importedAt).toLocaleString();
    status.append(
      Object.assign(document.createElement('p'), {
        textContent: `${summary.imported} pictures from “${summary.folderName}”, imported ${when}.`,
      }),
    );
    const skipped: string[] = [];
    if (summary.skippedFiles > 0) skipped.push(`${summary.skippedFiles} files that aren’t supported pictures`);
    if (summary.skippedFolders.length > 0) {
      skipped.push(`folders nested too deep: ${summary.skippedFolders.join(', ')}`);
    }
    if (skipped.length > 0) {
      status.append(Object.assign(document.createElement('p'), { className: 'warn', textContent: `Skipped ${skipped.join('; ')}.` }));
    }
  }

  const counts = new Map<string, number>();
  for (const m of images) {
    const label = `${m.domain ?? 'All sites'} · ${m.folder ? `[img ${m.folder}]` : 'top level'}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  groups.replaceChildren(
    ...[...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, n]) => li(label, `${n} ${n === 1 ? 'picture' : 'pictures'}`)),
  );

  refresh.hidden = !handle;
  clear.hidden = images.length === 0 && !summary;
}

async function run(button: HTMLButtonElement, task: () => Promise<void>): Promise<void> {
  const buttons = [choose, refresh, clear];
  for (const b of buttons) b.disabled = true;
  const label = button.textContent;
  button.textContent = 'Working…';
  try {
    await task();
  } catch (err) {
    if ((err as DOMException).name !== 'AbortError') {
      console.error('[wtv] options:', err);
      status.replaceChildren(
        Object.assign(document.createElement('p'), { className: 'warn', textContent: `Failed: ${(err as Error).message}` }),
      );
      return;
    }
  } finally {
    button.textContent = label;
    for (const b of buttons) b.disabled = false;
  }
  await render();
}

choose.addEventListener('click', () => {
  void run(choose, async () => {
    const handle = await window.showDirectoryPicker({ id: 'wtv-images', mode: 'read', startIn: 'pictures' });
    await importFolder(handle);
  });
});

refresh.addEventListener('click', () => {
  void run(refresh, async () => {
    const handle = await getKv<FileSystemDirectoryHandle>(KV_FOLDER_HANDLE);
    if (!handle) return;
    if (!(await ensureReadPermission(handle))) throw new Error('Permission to read the folder was denied.');
    await importFolder(handle);
  });
});

clear.addEventListener('click', () => {
  void run(clear, async () => {
    await replaceLibrary([]);
    await deleteKv(KV_IMPORT_SUMMARY);
    await deleteKv(KV_FOLDER_HANDLE);
  });
});

testForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const host = testHost.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  const keyword = testKeyword.value.trim() || null;
  const found = resolveImages(library, host, keyword);
  if (found.length === 0) {
    testResult.replaceChildren(
      li('Nothing matched: built-in cats'),
      ...BUNDLED_IMAGES.map((b) => li(b.path, seconds(b.durationMs), 'duration')),
    );
  } else {
    testResult.replaceChildren(...found.map((m) => li(m.id, seconds(m.durationMs), 'duration')));
  }
});

void render();
