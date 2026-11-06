/**
 * Playlist text format: parser, serializer, compiler, and structured edits. Pure.
 *
 * Grammar (one construct per line; leading / trailing whitespace is not significant,
 * but is preserved):
 *
 *   playlist  := line*
 *   line      := blank | comment | ads | quote | img | entry
 *   blank     := whitespace only
 *   comment   := "#" any  |  "//" any
 *   ads       := "[ads]"                                  (case-insensitive)
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
 *
 * Round trip: the document keeps every line's raw text, so serialize(parse(text)) ===
 * text (line endings normalized to the first one found). Structured edits re-render
 * only the lines they touch, keeping that line's indentation.
 *
 * Anything unrecognised is kept as an `invalid` line and reported as a problem, never
 * dropped.
 */
import type { ProgramItem } from '../overlay/program';
import { parseTimestamp } from './time';

export interface EntryOption {
  key: string;
  value: string;
}

export type Line =
  | { kind: 'blank'; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'ads'; raw: string }
  | { kind: 'quote'; raw: string; durationS: number; text: string }
  | { kind: 'img'; raw: string; keyword: string | null; durationS: number | null }
  | { kind: 'entry'; raw: string; url: string; title: string | null; options: EntryOption[] }
  | { kind: 'invalid'; raw: string; error: string };

export interface PlaylistDoc {
  lines: Line[];
  newline: '\n' | '\r\n';
  trailingNewline: boolean;
}

export interface PlaylistEntry {
  url: string;
  title: string | null;
  /** From `t=`, seconds. */
  startS: number | null;
  /** The entry's own `[ads]` block, else the playlist default, else null (site images). */
  ads: ProgramItem[] | null;
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
  problems: Problem[];
}

const MAX_TEXT = 500;
const KNOWN_OPTIONS = new Set(['t']);
const ADS_RE = /^\[ads\]$/i;
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

  const img = IMG_RE.exec(body);
  if (img) return parseImg(raw, img[1]);

  if (URL_RE.test(body)) return parseEntry(raw, body);

  const quote = QUOTE_RE.exec(body);
  if (quote) {
    const durationS = Number(quote[1]);
    if (durationS <= 0) return { kind: 'invalid', raw, error: 'quote duration must be more than 0 seconds' };
    return { kind: 'quote', raw, durationS, text: quote[2]!.trim().slice(0, MAX_TEXT) };
  }
  return { kind: 'invalid', raw, error: 'not a URL, [ads], [img …], "N: text" or # comment' };
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
  const defaultItems: ProgramItem[] = [];
  const entries: (PlaylistEntry & { own: ProgramItem[] })[] = [];
  /** Where quote / img lines go right now. */
  let block: ProgramItem[] | null = null;

  doc.lines.forEach((line, i) => {
    const at = i + 1;
    switch (line.kind) {
      case 'entry': {
        let startS: number | null = null;
        for (const opt of line.options) {
          if (opt.key === 't') {
            startS = parseTimestamp(opt.value);
            if (startS === null) problems.push({ line: at, message: `t=${opt.value} is not a timestamp` });
          } else if (!KNOWN_OPTIONS.has(opt.key)) {
            problems.push({ line: at, message: `unknown option ${opt.key}= (kept, ignored)` });
          }
        }
        entries.push({ url: line.url, title: line.title, startS, ads: null, line: i, own: [] });
        block = null;
        break;
      }
      case 'ads':
        block = entries.length === 0 ? defaultItems : entries[entries.length - 1]!.own;
        break;
      case 'quote':
      case 'img': {
        const item: ProgramItem =
          line.kind === 'quote'
            ? { kind: 'text', text: line.text, durationS: line.durationS }
            : { kind: 'img', keyword: line.keyword, durationS: line.durationS };
        if (block) block.push(item);
        else problems.push({ line: at, message: 'outside an [ads] block (ignored)' });
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

  const defaultAds = defaultItems.length > 0 ? defaultItems : null;
  return {
    entries: entries.map(({ own, ...e }) => ({ ...e, ads: own.length > 0 ? own : defaultAds })),
    defaultAds,
    problems,
  };
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
