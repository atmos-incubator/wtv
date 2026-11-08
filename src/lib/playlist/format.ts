/**
 * Playlist text format: parser, serializer, compiler, and structured edits. Pure.
 *
 * Grammar (one construct per line; leading / trailing whitespace is not significant,
 * but is preserved):
 *
 *   playlist  := line*
 *   line      := blank | comment | ads | show | view | speed | shuffle | loop | quote | img | entry
 *   blank     := whitespace only
 *   comment   := "#" any  |  "//" any
 *   ads       := "[ads]"                                  (case-insensitive)
 *   show      := "[show]"                                 (case-insensitive)
 *   view      := "[view" " " mode "]"                     e.g. `[view pictures]`
 *   speed     := "[speed" " " number unit "]"            e.g. `[speed 200 wpm]`, `[speed 40 px/s]`
 *   shuffle   := "[shuffle]"                              (case-insensitive)
 *   loop      := "[loop]"                                 (case-insensitive)
 *   quote     := seconds ":" text                         e.g. `20: Take a moment to breathe`
 *   img       := "[img" (" " keyword)? (" " seconds)? "]" e.g. `[img]`, `[img cats]`, `[img cats 10]`
 *   entry     := url ("|" field)*                         url is http(s)
 *   field     := key "=" value                            option, e.g. `t=1:37`
 *              | text                                     title (first non-option field)
 *   seconds   := positive number
 *
 * Scoping: an `[ads]` line opens a block that collects the quote / img lines after it,
 * up to the next entry line. A block before the first entry is the playlist-wide
 * default; a block after an entry overrides the default for that entry only.
 * `[show]` blocks scope the same way and pick the pictures for entries shown as pictures.
 *
 * Views: an entry's `view=` option, else the playlist-wide `[view …]` line before the
 * first entry, else `video`.
 *   - `pictures`: the media plays unseen behind a slideshow (music, radio, podcasts). Its
 *     pictures are the entry's `[show]` block, else the playlist's `[show]`, else the
 *     entry's ads program, else the site's pictures.
 *   - `read`: the page's article, as large text scrolled at a reading pace; `scroll`: the
 *     page itself, scrolled to the bottom. `speed=` (words per minute for `read`, pixels
 *     a second for `scroll`), else the playlist's `[speed …]` for that unit, else the
 *     default (page-show/pace.ts). `dur=` / `end=` is how long it shows; `t=` is ignored.
 *   - `card`: a post (posts/adapters.ts: X so far) on a full-screen title card, for
 *     `dur=` or a time from its length.
 *
 * Times: `t=` starts the entry there; `end=` stops it there, or `dur=` that long after the
 * start. `end=` wins if both are given (flagged). An end at or before the start is
 * ignored (flagged).
 *
 * Order: `[shuffle]` before the first entry plays the playlist in a random order;
 * `[loop]` after the last entry starts it again when it ends. Both are defaults for the
 * Play buttons, which can turn them off.
 *
 * Round trip: the document keeps every line's raw text, so serialize(parse(text)) ===
 * text (line endings normalized to the first one found). Structured edits re-render
 * only the lines they touch, keeping that line's indentation.
 *
 * Anything unrecognised is kept as an `invalid` line and reported as a problem, never
 * dropped.
 */
import type { ProgramItem } from '../overlay/program';
import { parseSpeed, speedProblem, type Speed, type SpeedUnit } from '../page-show/pace';
import { POST_SITES, findPostAdapter } from '../posts/adapters';
import { parseTimestamp } from './time';

export interface EntryOption {
  key: string;
  value: string;
}

export type Line =
  | { kind: 'blank'; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'ads'; raw: string }
  | { kind: 'show'; raw: string }
  | { kind: 'view'; raw: string; mode: string }
  | { kind: 'speed'; raw: string; value: string }
  | { kind: 'shuffle'; raw: string }
  | { kind: 'loop'; raw: string }
  | { kind: 'quote'; raw: string; durationS: number; text: string }
  | { kind: 'img'; raw: string; keyword: string | null; durationS: number | null }
  | { kind: 'entry'; raw: string; url: string; title: string | null; options: EntryOption[] }
  | { kind: 'invalid'; raw: string; error: string };

export interface PlaylistDoc {
  lines: Line[];
  newline: '\n' | '\r\n';
  trailingNewline: boolean;
}

export const VIEW_MODES = ['video', 'pictures', 'read', 'scroll', 'card'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
export const isViewMode = (v: unknown): v is ViewMode => (VIEW_MODES as readonly unknown[]).includes(v);
/** Shown in the entry's own page, by the content script, with no media to play. */
export const isPageView = (v: ViewMode): v is 'read' | 'scroll' => v === 'read' || v === 'scroll';
/** Something to watch or listen to: the media plays and its end ends the entry. */
export const isMediaView = (v: ViewMode): boolean => v === 'video' || v === 'pictures';

export interface PlaylistEntry {
  url: string;
  title: string | null;
  /** From `t=`, seconds. */
  startS: number | null;
  /** From `end=`, else `dur=` after the start; seconds of the media's own time. */
  endS: number | null;
  /** The entry's own `[ads]` block, else the playlist default, else null (site images). */
  ads: ProgramItem[] | null;
  view: ViewMode;
  /** Pictures for `view=pictures`: own `[show]`, playlist `[show]`, then `ads`; null = site images. */
  show: ProgramItem[] | null;
  /** `view=read`: words per minute; `view=scroll`: pixels a second; null: the default (or another view). */
  speed: number | null;
  /** Index into `doc.lines`. */
  line: number;
}

export interface Problem {
  /** 1-based, for display. */
  line: number;
  message: string;
}

export interface CompiledPlaylist {
  entries: PlaylistEntry[];
  defaultAds: ProgramItem[] | null;
  defaultShow: ProgramItem[] | null;
  defaultView: ViewMode;
  /** `[speed …]` lines before the first entry. */
  defaultSpeed: { wpm: number | null; pxPerS: number | null };
  /** `[shuffle]` before the first entry. */
  shuffle: boolean;
  /** `[loop]` after the last entry. */
  loop: boolean;
  problems: Problem[];
}

const MAX_TEXT = 500;
const KNOWN_OPTIONS = new Set(['t', 'end', 'dur', 'view', 'speed']);
const ADS_RE = /^\[ads\]$/i;
const SHOW_RE = /^\[show\]$/i;
const SHUFFLE_RE = /^\[shuffle\]$/i;
const LOOP_RE = /^\[loop\]$/i;
const VIEW_RE = /^\[view\s+([^\]\s]+)\s*\]$/i;
const SPEED_RE = /^\[speed\s+([^\]]*?)\s*\]$/i;
const IMG_RE = /^\[img(?:\s+([^\]]*?))?\s*\]$/i;
const QUOTE_RE = /^(\d+(?:\.\d+)?)\s*:\s*(.+)$/;
const URL_RE = /^https?:\/\//i;
const OPTION_RE = /^([a-z][a-z0-9_-]*)=(.*)$/i;
const NUMBER_RE = /^\d+(?:\.\d+)?$/;

// --- parse ---------------------------------------------------------------------------

function parseEntry(raw: string, body: string): Line {
  const [urlPart = '', ...fields] = body.split('|').map((f) => f.trim());
  try {
    const u = new URL(urlPart);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    return { kind: 'invalid', raw, error: `not a valid URL: ${urlPart}` };
  }
  let title: string | null = null;
  const options: EntryOption[] = [];
  for (const field of fields) {
    const opt = OPTION_RE.exec(field);
    if (opt) options.push({ key: opt[1]!.toLowerCase(), value: opt[2]!.trim() });
    else if (field && title === null) title = field;
    else if (field) title = `${title} | ${field}`;
  }
  return { kind: 'entry', raw, url: urlPart, title, options };
}

function parseImg(raw: string, inner: string | undefined): Line {
  const tokens = (inner ?? '').split(/\s+/).filter(Boolean);
  let durationS: number | null = null;
  const last = tokens[tokens.length - 1];
  if (last !== undefined && NUMBER_RE.test(last)) {
    durationS = Number(last);
    tokens.pop();
    if (durationS <= 0) return { kind: 'invalid', raw, error: 'image duration must be more than 0 seconds' };
  }
  return { kind: 'img', raw, keyword: tokens.length > 0 ? tokens.join(' ') : null, durationS };
}

export function parseLine(raw: string): Line {
  const body = raw.trim();
  if (!body) return { kind: 'blank', raw };
  if (body.startsWith('#') || body.startsWith('//')) return { kind: 'comment', raw };
  if (ADS_RE.test(body)) return { kind: 'ads', raw };
  if (SHOW_RE.test(body)) return { kind: 'show', raw };
  if (SHUFFLE_RE.test(body)) return { kind: 'shuffle', raw };
  if (LOOP_RE.test(body)) return { kind: 'loop', raw };
  const view = VIEW_RE.exec(body);
  if (view) return { kind: 'view', raw, mode: view[1]!.toLowerCase() };
  const speed = SPEED_RE.exec(body);
  if (speed) return { kind: 'speed', raw, value: speed[1]! };

  const img = IMG_RE.exec(body);
  if (img) return parseImg(raw, img[1]);

  if (URL_RE.test(body)) return parseEntry(raw, body);

  const quote = QUOTE_RE.exec(body);
  if (quote) {
    const durationS = Number(quote[1]);
    if (durationS <= 0) return { kind: 'invalid', raw, error: 'quote duration must be more than 0 seconds' };
    return { kind: 'quote', raw, durationS, text: quote[2]!.trim().slice(0, MAX_TEXT) };
  }
  return {
    kind: 'invalid',
    raw,
    error: 'not a URL, [ads], [show], [view …], [speed …], [shuffle], [loop], [img …], "N: text" or # comment',
  };
}

export function parsePlaylist(text: string): PlaylistDoc {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(text);
  const body = trailingNewline ? text.replace(/\r?\n$/, '') : text;
  const lines = text === '' ? [] : body.split(/\r?\n/).map(parseLine);
  return { lines, newline, trailingNewline };
}

export function serializePlaylist(doc: PlaylistDoc): string {
  if (doc.lines.length === 0) return doc.trailingNewline ? doc.newline : '';
  return doc.lines.map((l) => l.raw).join(doc.newline) + (doc.trailingNewline ? doc.newline : '');
}

// --- compile -------------------------------------------------------------------------

export function compilePlaylist(doc: PlaylistDoc): CompiledPlaylist {
  const problems: Problem[] = [];
  const defaultAds: ProgramItem[] = [];
  const defaultShow: ProgramItem[] = [];
  let defaultView: ViewMode = 'video';
  const defaultSpeed: CompiledPlaylist['defaultSpeed'] = { wpm: null, pxPerS: null };
  let shuffle = false;
  /** Line of the last `[loop]`; it only counts if no entry follows it. */
  let loopAt: number | null = null;
  type Draft = Omit<PlaylistEntry, 'ads' | 'view' | 'show' | 'speed'> & {
    view: ViewMode | null;
    ownSpeed: Speed | null;
    ownAds: ProgramItem[];
    ownShow: ProgramItem[];
  };
  const entries: Draft[] = [];
  /** Where quote / img lines go right now. */
  let block: ProgramItem[] | null = null;

  doc.lines.forEach((line, i) => {
    const at = i + 1;
    const last = entries[entries.length - 1];
    switch (line.kind) {
      case 'entry': {
        let startS: number | null = null;
        let endOpt: EntryOption | null = null;
        let durOpt: EntryOption | null = null;
        let view: ViewMode | null = null;
        let speed: Speed | null = null;
        for (const opt of line.options) {
          if (opt.key === 't') {
            startS = parseTimestamp(opt.value);
            if (startS === null) problems.push({ line: at, message: `t=${opt.value} is not a timestamp` });
          } else if (opt.key === 'end') {
            endOpt = opt;
          } else if (opt.key === 'dur') {
            durOpt = opt;
          } else if (opt.key === 'view') {
            const mode = opt.value.toLowerCase();
            if (isViewMode(mode)) view = mode;
            else problems.push({ line: at, message: `view=${opt.value}: expected ${VIEW_MODES.join(', ')}` });
          } else if (opt.key === 'speed') {
            speed = parseSpeed(opt.value);
            if (!speed) problems.push({ line: at, message: `speed=${opt.value}: expected a number, like speed=200 (wpm) or speed=40 (px/s)` });
          } else if (!KNOWN_OPTIONS.has(opt.key)) {
            problems.push({ line: at, message: `unknown option ${opt.key}= (kept, ignored)` });
          }
        }
        const shown = view ?? defaultView;
        if (startS !== null && !isMediaView(shown)) {
          problems.push({ line: at, message: `t= doesn't apply to view=${shown} (ignored)` });
          startS = null;
        }
        if (speed) speed = checkSpeed(speed, shown, (message) => problems.push({ line: at, message }));
        if (shown === 'card' && !findPostAdapter(line.url)) {
          problems.push({ line: at, message: `view=card: not a post Wtv can read (so far: posts on ${POST_SITES})` });
        }
        const endS = entryEnd(startS, endOpt, durOpt, (message) => problems.push({ line: at, message }));
        entries.push({ url: line.url, title: line.title, startS, endS, view, ownSpeed: speed, line: i, ownAds: [], ownShow: [] });
        block = null;
        if (loopAt !== null) {
          problems.push({ line: loopAt, message: '[loop] goes after the last entry (ignored)' });
          loopAt = null;
        }
        break;
      }
      case 'ads':
        block = last ? last.ownAds : defaultAds;
        break;
      case 'show':
        block = last ? last.ownShow : defaultShow;
        break;
      case 'view':
        if (!isViewMode(line.mode)) {
          problems.push({ line: at, message: `[view ${line.mode}]: expected ${VIEW_MODES.join(', ')}` });
        } else if (last) {
          problems.push({ line: at, message: '[view …] goes before the first entry; use view= on an entry (ignored)' });
        } else {
          defaultView = line.mode;
        }
        break;
      case 'speed': {
        const speed = parseSpeed(line.value);
        if (last) {
          problems.push({ line: at, message: '[speed …] goes before the first entry; use speed= on an entry (ignored)' });
        } else if (!speed || !speed.unit) {
          problems.push({ line: at, message: `[speed ${line.value}]: expected a number and wpm or px/s, like [speed 200 wpm]` });
        } else {
          const range = speedProblem(speed.value, speed.unit);
          if (range) problems.push({ line: at, message: `[speed ${line.value}]: expected ${range} (ignored)` });
          else if (speed.unit === 'wpm') defaultSpeed.wpm = speed.value;
          else defaultSpeed.pxPerS = speed.value;
        }
        break;
      }
      case 'shuffle':
        if (last) problems.push({ line: at, message: '[shuffle] goes before the first entry (ignored)' });
        else shuffle = true;
        break;
      case 'loop':
        loopAt ??= at;
        break;
      case 'quote':
      case 'img': {
        const item: ProgramItem =
          line.kind === 'quote'
            ? { kind: 'text', text: line.text, durationS: line.durationS }
            : { kind: 'img', keyword: line.keyword, durationS: line.durationS };
        if (block) block.push(item);
        else problems.push({ line: at, message: 'outside an [ads] or [show] block (ignored)' });
        break;
      }
      case 'invalid':
        problems.push({ line: at, message: line.error });
        break;
      case 'blank':
      case 'comment':
        break;
    }
  });

  const ads = defaultAds.length > 0 ? defaultAds : null;
  const show = defaultShow.length > 0 ? defaultShow : null;
  return {
    entries: entries.map(({ ownAds, ownShow, view, ownSpeed, ...e }) => {
      const entryAds = ownAds.length > 0 ? ownAds : ads;
      const shown = view ?? defaultView;
      const playlistSpeed = shown === 'read' ? defaultSpeed.wpm : shown === 'scroll' ? defaultSpeed.pxPerS : null;
      return {
        ...e,
        ads: entryAds,
        view: shown,
        show: ownShow.length > 0 ? ownShow : (show ?? entryAds),
        speed: ownSpeed?.value ?? playlistSpeed,
      };
    }),
    defaultAds: ads,
    defaultShow: show,
    defaultView,
    defaultSpeed,
    shuffle,
    loop: loopAt !== null && entries.length > 0,
    problems,
  };
}

/** An entry's `speed=` for its view: null (and a problem) if it doesn't fit. */
function checkSpeed(speed: Speed, view: ViewMode, problem: (message: string) => void): Speed | null {
  if (!isPageView(view)) {
    problem('speed= only applies to view=read and view=scroll (ignored)');
    return null;
  }
  const unit: SpeedUnit = view === 'read' ? 'wpm' : 'px/s';
  if (speed.unit && speed.unit !== unit) {
    problem(`speed=: view=${view} takes ${unit === 'wpm' ? 'words per minute (wpm)' : 'pixels a second (px/s)'} (ignored)`);
    return null;
  }
  const range = speedProblem(speed.value, unit);
  if (range) {
    problem(`speed=${speed.value}: expected ${range} (ignored)`);
    return null;
  }
  return { value: speed.value, unit };
}

/** `end=` (an absolute time) or `dur=` (a length from the start), in seconds. */
function entryEnd(
  startS: number | null,
  endOpt: EntryOption | null,
  durOpt: EntryOption | null,
  problem: (message: string) => void,
): number | null {
  if (endOpt && durOpt) problem(`end= and dur= both given; using end=${endOpt.value}`);
  const from = startS ?? 0;
  if (endOpt) {
    const endS = parseTimestamp(endOpt.value);
    if (endS === null) problem(`end=${endOpt.value} is not a timestamp`);
    else if (endS <= from) problem(`end=${endOpt.value} is not after the start time (ignored)`);
    else return endS;
    return null;
  }
  if (durOpt) {
    const durS = parseTimestamp(durOpt.value);
    if (durS === null) problem(`dur=${durOpt.value} is not a duration`);
    else if (durS <= 0) problem(`dur=${durOpt.value} must be more than 0 seconds (ignored)`);
    else return from + durS;
  }
  return null;
}

// --- edits ---------------------------------------------------------------------------

/** Titles can't contain line breaks, and a bare `key=value` would read back as an option. */
function cleanTitle(title: string | null): string | null {
  const t = title?.replace(/\s+/g, ' ').trim() ?? '';
  if (!t) return null;
  return OPTION_RE.test(t) ? t.replace('=', ' = ') : t;
}

export function renderEntry(url: string, title: string | null, options: readonly EntryOption[] = [], indent = ''): string {
  const parts = [url.trim()];
  const t = cleanTitle(title);
  if (t) parts.push(t);
  for (const o of options) parts.push(`${o.key}=${o.value}`);
  return indent + parts.join(' | ');
}

function indentOf(raw: string): string {
  return /^\s*/.exec(raw)?.[0] ?? '';
}

/** Change an entry's title (entryIndex counts entries, not lines). */
export function withEntryTitle(doc: PlaylistDoc, entryIndex: number, title: string | null): PlaylistDoc {
  let seen = -1;
  const lines = doc.lines.map((line): Line => {
    if (line.kind !== 'entry' || ++seen !== entryIndex) return line;
    const raw = renderEntry(line.url, title, line.options, indentOf(line.raw));
    return { ...line, raw, title: cleanTitle(title) };
  });
  return { ...doc, lines };
}

/** Append an entry at the end (after a blank line if the last line isn't blank). */
export function appendEntry(doc: PlaylistDoc, url: string, title: string | null): PlaylistDoc {
  const line = parseLine(renderEntry(url, title));
  if (line.kind !== 'entry') throw new Error(`not a playlist URL: ${url}`);
  const lines = [...doc.lines];
  const last = lines[lines.length - 1];
  if (last && last.kind !== 'blank') lines.push({ kind: 'blank', raw: '' });
  lines.push(line);
  return { ...doc, lines, trailingNewline: doc.lines.length === 0 ? true : doc.trailingNewline };
}

/**
 * Remove entries (entryIndexes count entries, not lines), each with its own `[ads]` /
 * `[show]` blocks: the lines after it, up to the next entry, that belong to those blocks.
 * Comments, blank lines and anything else (a `[loop]`, say) stay. Where a removal leaves
 * two blank lines together, one goes.
 */
export function withoutEntries(doc: PlaylistDoc, entryIndexes: ReadonlySet<number>): PlaylistDoc {
  if (entryIndexes.size === 0) return doc;
  const blockLine = (l: Line) => l.kind === 'ads' || l.kind === 'show' || l.kind === 'quote' || l.kind === 'img';
  const lines: Line[] = [];
  let seen = -1;
  let removing = false;
  /** Lines were dropped since the last line kept. */
  let gap = false;
  for (const line of doc.lines) {
    if (line.kind === 'entry') removing = entryIndexes.has(++seen);
    if (removing && (line.kind === 'entry' || blockLine(line))) {
      gap = true;
      continue;
    }
    const last = lines[lines.length - 1];
    if (gap && line.kind === 'blank' && (last === undefined || last.kind === 'blank')) continue;
    lines.push(line);
    gap = false;
  }
  // Removed at the end: drop the blank lines that separated it.
  if (gap) while (lines[lines.length - 1]?.kind === 'blank') lines.pop();
  return { ...doc, lines };
}
