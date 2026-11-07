/**
 * Built-in playlists: text files shipped in `src/playlists/<id>.txt`, in the playlist
 * format, whose first line is `# name: <Name>` (a comment, so the text plays as-is). An
 * optional `src/playlists/<id>.svg` beside it is the placeholder cover until the
 * playlist's entries have thumbnails of their own. Pure: shared by the runtime loader
 * (builtin-bundle.ts, Vite globs) and wxt.config.ts (node fs), so a bad file fails the
 * build, like site configs.
 *
 *   - Strict: any problem the editor would report is an error.
 *   - A file with no entries yet is skipped, with a note, so playlists can be stubbed.
 *   - Read-only in the app; **Duplicate** makes an editable copy.
 */
import { compilePlaylist, parsePlaylist } from './format';
import type { StoredPlaylist } from './store';

export const BUILTIN_PREFIX = 'builtin-';
const NAME_LINE = /^#\s*name:\s*(.+?)\s*$/i;
const STEM = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME = 80;
export const MAX_SVG_BYTES = 50 * 1024;

export interface BuiltinPlaylist extends StoredPlaylist {
  builtin: true;
  /** URL of the placeholder SVG, if one ships. */
  cover: string | null;
}

export interface BuiltinLoad {
  playlists: BuiltinPlaylist[];
  errors: string[];
  /** Skipped files, and SVGs with no playlist. */
  notes: string[];
}

export const isBuiltinId = (id: string): boolean => id.startsWith(BUILTIN_PREFIX);

function stemOf(path: string, ext: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.slice(0, file.length - ext.length);
}

/**
 * `texts`: file path → contents of each `.txt`. `covers`: file path → URL (runtime) or
 * contents (build) of each `.svg`; only which stems have one matters here.
 */
export function loadBuiltinPlaylists(texts: Record<string, string>, covers: Record<string, string> = {}): BuiltinLoad {
  const playlists: BuiltinPlaylist[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  const coverByStem = new Map(Object.entries(covers).map(([path, url]) => [stemOf(path, '.svg'), url]));
  const stems = new Set<string>();

  for (const [path, text] of Object.entries(texts).sort(([a], [b]) => a.localeCompare(b))) {
    const stem = stemOf(path, '.txt');
    stems.add(stem);
    const at = `playlists/${stem}.txt`;
    if (!STEM.test(stem)) {
      errors.push(`${at}: file names are lowercase letters, digits and dashes`);
      continue;
    }
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const name = NAME_LINE.exec(firstLine)?.[1];
    if (!name) {
      errors.push(`${at}: the first line must be "# name: <Playlist name>"`);
      continue;
    }
    if (name.length > MAX_NAME) errors.push(`${at}: the name is longer than ${MAX_NAME} characters`);
    const compiled = compilePlaylist(parsePlaylist(text));
    for (const p of compiled.problems) errors.push(`${at}:${p.line}: ${p.message}`);
    if (compiled.problems.length > 0) continue;
    if (compiled.entries.length === 0) {
      notes.push(`${at}: no entries yet, not shipped`);
      continue;
    }
    playlists.push({
      id: BUILTIN_PREFIX + stem,
      name,
      text,
      createdAt: 0,
      updatedAt: 0,
      builtin: true,
      cover: coverByStem.get(stem) ?? null,
    });
  }
  for (const stem of coverByStem.keys()) {
    if (!stems.has(stem)) notes.push(`playlists/${stem}.svg: no ${stem}.txt beside it, ignored`);
  }
  playlists.sort((a, b) => a.name.localeCompare(b.name));
  return { playlists, errors, notes };
}

/**
 * Build-time check of a placeholder SVG. It's only ever shown with `<img>` (which runs no
 * scripts and loads nothing external), but it ships to every user, so keep it plain: an
 * SVG, small, no scripts, event handlers, external references or embedded HTML.
 */
export function checkSvg(text: string, bytes: number): string[] {
  const errors: string[] = [];
  if (bytes > MAX_SVG_BYTES) errors.push(`${Math.round(bytes / 1024)} kB; the limit is ${MAX_SVG_BYTES / 1024} kB`);
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(body)) errors.push('not an SVG (it must start with <svg>)');
  if (/<script[\s/>]/i.test(body)) errors.push('contains a <script>');
  if (/<foreignObject[\s/>]/i.test(body)) errors.push('contains a <foreignObject>');
  if (/\son[a-z]+\s*=/i.test(body)) errors.push('contains an event handler attribute (on…=)');
  for (const m of body.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    if (!m[1]!.startsWith('#')) errors.push(`references ${m[1]} (only #fragment links are allowed)`);
  }
  if (/url\(\s*["']?(?!#)/i.test(body)) errors.push('contains a url(…) that isn’t a #fragment');
  if (/@import/i.test(body)) errors.push('contains an @import');
  return errors;
}
