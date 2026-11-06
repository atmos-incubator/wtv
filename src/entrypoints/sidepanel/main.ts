/**
 * Selector side panel: inspect each role's selectors on the current tab, pick elements
 * to generate new ones, test them live, and save them as local overrides.
 * Dev builds can also write the resulting site config straight into src/sites/.
 */
import './style.css';
import { browser } from 'wxt/browser';
import { browserAreas } from '../../lib/browser-storage';
import { DEV_TOOLS } from '../../lib/env';
import { getKv, setKv } from '../../lib/images/db';
import {
  PICK_CANCEL,
  PICK_CANCELLED,
  PICK_KEY,
  PICK_RESULT,
  PICK_ROLES,
  PICK_START,
  PICK_TEST,
  type Candidate,
  type PickKey,
  type PickResult,
  type RoleReport,
  type RolesReport,
  type TestResult,
} from '../../lib/picker/messages';
import { ROLE_HINTS, ROLE_LABELS } from '../../lib/picker/roles';
import { siteConfigToJson } from '../../lib/picker/serialize';
import { BUNDLED_SITES } from '../../lib/sites/bundled';
import { loadOverrideStore, saveOverrideStore } from '../../lib/sites/override-store';
import { resolveSite, withRoleOverride, withoutRoleOverride } from '../../lib/sites/overrides';
import { CONDITIONS, ROLE_DEFAULT_WHEN, type Condition, type Matcher, type RoleName } from '../../lib/sites/schema';
import { validateMatchers } from '../../lib/sites/validate';

const app = document.getElementById('app') as HTMLElement;
const local = browserAreas().local;
const KV_REPO_SITES = 'repoSitesHandle';
const PICK_DELAY_MS = 5000;

interface Editor {
  role: RoleName;
  element: string | null;
  candidates: Candidate[];
  selector: string;
  when: Condition | null;
  keepExisting: boolean;
  test: TestResult | null;
}

const state: {
  tabId: number | null;
  frameId: number;
  report: RolesReport | null;
  error: string | null;
  picking: RoleName | null;
  editor: Editor | null;
  message: string | null;
} = { tabId: null, frameId: 0, report: null, error: null, picking: null, editor: null, message: null };

// --- DOM helpers ---------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; className?: string } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className) node.className = props.className;
  for (const c of children) if (c) node.append(c);
  return node;
}

function button(text: string, onClick: () => void | Promise<void>, className = ''): HTMLButtonElement {
  const b = el('button', { text, className });
  b.type = 'button';
  b.addEventListener('click', () => {
    void Promise.resolve(onClick()).catch((err: unknown) => {
      state.message = `Failed: ${(err as Error).message}`;
      render();
    });
  });
  return b;
}

// --- tab messaging ---------------------------------------------------------------------

async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function toFrame<T>(message: unknown): Promise<T> {
  if (state.tabId === null) throw new Error('No tab');
  return (await browser.tabs.sendMessage(state.tabId, message, { frameId: state.frameId })) as T;
}

function toAllFrames(message: unknown): void {
  if (state.tabId !== null) browser.tabs.sendMessage(state.tabId, message).catch(() => undefined);
}

async function refresh(): Promise<void> {
  state.tabId = await activeTabId();
  try {
    state.report = await toFrame<RolesReport>({ type: PICK_ROLES });
    state.error = null;
  } catch {
    state.report = null;
    state.error = 'Wtv isn’t running on this page. Enable it from the toolbar popup, or reload the page.';
  }
  render();
}

// --- picking / testing / saving -----------------------------------------------------------

function startPick(role: RoleName, delayMs: number): void {
  state.frameId = 0;
  state.picking = role;
  state.editor = null;
  state.message = delayMs > 0 ? 'Get the element on screen; picking starts in 5 s.' : 'Click the element in the page.';
  toAllFrames({ type: PICK_START, role, delayMs });
  render();
}

function cancelPick(): void {
  toAllFrames({ type: PICK_CANCEL });
  state.picking = null;
  state.message = null;
  render();
}

let testTimer: ReturnType<typeof setTimeout> | undefined;
function testSoon(): void {
  if (testTimer !== undefined) clearTimeout(testTimer);
  testTimer = setTimeout(() => void runTest(), 300);
}

async function runTest(): Promise<void> {
  const ed = state.editor;
  if (!ed || !ed.selector.trim()) return;
  try {
    ed.test = await toFrame<TestResult>({ type: PICK_TEST, role: ed.role, selector: ed.selector, when: ed.when });
  } catch {
    ed.test = { count: 0, satisfied: false, error: 'Could not reach the page.' };
  }
  render();
}

function siteIdentity(report: RolesReport): { siteId: string; bundled: (typeof BUNDLED_SITES)[number] | undefined } {
  const siteId = report.siteId ?? report.host.replace(/^www\./, '');
  return { siteId, bundled: BUNDLED_SITES.find((s) => s.id === siteId) };
}

/** Drop `when` where it equals the role default, so stored matchers stay minimal. */
function normalize(role: RoleName, selector: string, when: Condition | null): Matcher {
  return when && when !== ROLE_DEFAULT_WHEN[role] ? { selector, when } : { selector };
}

async function save(): Promise<void> {
  const ed = state.editor;
  const report = state.report;
  if (!ed || !report) return;

  const errors: string[] = [];
  const [first] = validateMatchers([normalize(ed.role, ed.selector.trim(), ed.when)], 'selector', errors, []);
  if (!first || errors.length > 0) {
    state.message = errors.join('; ') || 'Enter a selector.';
    render();
    return;
  }

  const { siteId, bundled } = siteIdentity(report);
  const existing = ed.keepExisting
    ? (report.roles.find((r) => r.role === ed.role)?.matchers ?? [])
        .filter((m) => m.selector !== first.selector)
        .map((m) => normalize(ed.role, m.selector, m.when))
    : [];

  const store = await loadOverrideStore(local);
  const next = withRoleOverride(store, bundled, siteId, ed.role, [first, ...existing], {
    name: store[siteId]?.name ?? report.siteName ?? siteId,
    domains: store[siteId]?.domains ?? [siteId],
  });
  await saveOverrideStore(local, next);

  state.editor = null;
  state.message = `Saved ${ROLE_LABELS[ed.role].toLowerCase()} selector for ${siteId}.`;
  // Let the content script pick up the storage change before re-reading.
  setTimeout(() => void refresh(), 400);
}

async function resetRole(role: RoleName): Promise<void> {
  if (!state.report) return;
  const { siteId } = siteIdentity(state.report);
  const store = await loadOverrideStore(local);
  await saveOverrideStore(local, withoutRoleOverride(store, siteId, role));
  state.message = `${ROLE_LABELS[role]} reset to the built-in selectors.`;
  setTimeout(() => void refresh(), 400);
}

async function effectiveConfigJson(): Promise<{ siteId: string; json: string } | null> {
  if (!state.report) return null;
  const { siteId, bundled } = siteIdentity(state.report);
  const store = await loadOverrideStore(local);
  const resolved = resolveSite(siteId, bundled, store[siteId]);
  return resolved ? { siteId, json: siteConfigToJson(resolved.config) } : null;
}

async function copyJson(): Promise<void> {
  const out = await effectiveConfigJson();
  if (!out) {
    state.message = 'Nothing to copy yet: this site has no selectors.';
  } else {
    await navigator.clipboard.writeText(out.json);
    state.message = `Copied ${out.siteId}.json to the clipboard.`;
  }
  render();
}

/** Dev only: write <siteId>.json into the repo's src/sites folder. */
async function writeToRepo(): Promise<void> {
  const out = await effectiveConfigJson();
  if (!out) {
    state.message = 'Nothing to write yet: this site has no selectors.';
    render();
    return;
  }
  let dir = await getKv<FileSystemDirectoryHandle>(KV_REPO_SITES);
  if (dir && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = undefined;
  }
  if (!dir) {
    dir = await window.showDirectoryPicker({ id: 'wtv-repo-sites', mode: 'readwrite' });
    await setKv(KV_REPO_SITES, dir);
  }
  const file = await dir.getFileHandle(`${out.siteId}.json`, { create: true });
  const writable = await file.createWritable();
  await writable.write(out.json);
  await writable.close();
  state.message =
    dir.name === 'sites'
      ? `Wrote sites/${out.siteId}.json. Rebuild to ship it; the local override is dropped automatically once the bundled config matches.`
      : `Wrote ${out.siteId}.json into “${dir.name}” (expected the repo’s src/sites folder).`;
  render();
}

// --- incoming messages ---------------------------------------------------------------------

browser.runtime.onMessage.addListener((raw: unknown, sender) => {
  const msg = raw as { type?: unknown } | null;
  if (!msg || sender.tab?.id !== state.tabId) return undefined;
  if (msg.type === PICK_RESULT && state.picking) {
    const result = raw as PickResult;
    toAllFrames({ type: PICK_CANCEL }); // stop pickers in other frames
    state.frameId = sender.frameId ?? 0;
    state.picking = null;
    state.message = null;
    state.editor = {
      role: result.role,
      element: result.element,
      candidates: result.candidates,
      selector: result.candidates[0]?.selector ?? '',
      when: null,
      keepExisting: true,
      test: null,
    };
    render();
    void runTest();
  } else if (msg.type === PICK_CANCELLED && state.picking) {
    state.picking = null;
    state.message = 'Picking cancelled.';
    render();
  }
  return undefined;
});

// The panel keeps keyboard focus while picking; forward the picker keys to the page.
const PANEL_KEYS: Record<string, PickKey> = { Escape: 'cancel', ArrowUp: 'up', ArrowDown: 'down', p: 'toggle', P: 'toggle' };
document.addEventListener('keydown', (e) => {
  const key = PANEL_KEYS[e.key];
  if (!state.picking || !key) return;
  e.preventDefault();
  toAllFrames({ type: PICK_KEY, key });
});

browser.tabs.onActivated.addListener(() => {
  cancelPick();
  state.editor = null;
  state.frameId = 0;
  void refresh();
});

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === 'complete') {
    state.editor = null;
    state.frameId = 0;
    void refresh();
  }
});

// --- rendering ---------------------------------------------------------------------------

function statusChip(r: RoleReport): HTMLElement {
  if (r.matchers.length === 0) return el('span', { className: 'chip', text: 'not set' });
  if (r.matchedIndex === null) return el('span', { className: 'chip bad', text: 'no match' });
  const which = r.matchers.length > 1 ? ` #${r.matchedIndex + 1}` : '';
  return el('span', { className: 'chip ok', text: `matched${which}${r.source === 'override' ? ' · yours' : ''}` });
}

function selectorList(r: RoleReport): HTMLElement | null {
  if (r.matchers.length === 0) return null;
  return el(
    'ul',
    { className: 'selectors' },
    ...r.matchers.map((m, i) =>
      el(
        'li',
        {},
        el('span', { className: i === r.matchedIndex ? 'hit' : m.satisfied ? '' : 'miss', text: m.satisfied ? '✓' : '✗' }),
        el('code', { text: m.selector }),
        el('span', { className: 'count', text: m.error ? 'invalid' : `${m.count} · ${m.when}` }),
      ),
    ),
  );
}

function editorView(ed: Editor): HTMLElement {
  const input = el('input');
  input.type = 'text';
  input.value = ed.selector;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Selector');
  input.addEventListener('input', () => {
    ed.selector = input.value;
    testSoon();
  });

  const when = el('select');
  when.setAttribute('aria-label', 'Condition');
  for (const value of ['', ...CONDITIONS]) {
    const opt = el('option', { text: value ? value : `default (${ROLE_DEFAULT_WHEN[ed.role]})` });
    opt.value = value;
    opt.selected = (ed.when ?? '') === value;
    when.append(opt);
  }
  when.addEventListener('change', () => {
    ed.when = (when.value || null) as Condition | null;
    void runTest();
  });

  const keep = el('input');
  keep.type = 'checkbox';
  keep.checked = ed.keepExisting;
  keep.addEventListener('change', () => (ed.keepExisting = keep.checked));

  const candidates =
    ed.candidates.length > 0
      ? el(
          'div',
          { className: 'candidates' },
          ...ed.candidates.map((c) => {
            const radio = el('input');
            radio.type = 'radio';
            radio.name = 'candidate';
            radio.checked = c.selector === ed.selector;
            radio.addEventListener('change', () => {
              ed.selector = c.selector;
              input.value = c.selector;
              void runTest();
            });
            return el(
              'label',
              {},
              radio,
              el('code', { text: c.selector }),
              el('span', { className: 'count', text: `${c.count} · ${c.label}` }),
            );
          }),
        )
      : null;

  const t = ed.test;
  const testLine = t
    ? el('p', {
        className: t.error ? 'warn' : 'note',
        text: t.error
          ? t.error
          : `${t.count} match${t.count === 1 ? '' : 'es'} on the page${t.satisfied ? '' : ' · condition not met right now'} (outlined in green).`,
      })
    : null;

  return el(
    'div',
    { className: 'editor' },
    ed.element ? el('p', { className: 'note', text: `Picked ${ed.element}` }) : null,
    candidates,
    input,
    el('div', { className: 'row' }, when, el('label', { className: 'check' }, keep, document.createTextNode('Keep the current selectors as fallbacks'))),
    testLine,
    el(
      'div',
      { className: 'actions' },
      button('Save', save, 'primary'),
      button('Test', runTest),
      button('Cancel', () => {
        state.editor = null;
        render();
      }),
    ),
  );
}

function roleView(r: RoleReport): HTMLElement {
  const editing = state.editor?.role === r.role;
  const picking = state.picking === r.role;
  const busy = state.picking !== null;
  const actions = el('div', { className: 'actions' });
  if (picking) {
    actions.append(button('Stop picking', cancelPick));
  } else {
    const pick = button('Pick', () => startPick(r.role, 0));
    const later = button('Pick in 5 s', () => startPick(r.role, PICK_DELAY_MS));
    const type = button('Type selector', () => {
      state.editor = { role: r.role, element: null, candidates: [], selector: '', when: null, keepExisting: true, test: null };
      state.frameId = 0;
      render();
    });
    for (const b of [pick, later, type]) b.disabled = busy;
    actions.append(pick, later, type);
    if (r.source === 'override') actions.append(button('Reset', () => resetRole(r.role)));
  }

  return el(
    'section',
    { className: `role${editing ? ' editing' : ''}` },
    el('div', { className: 'role-head' }, el('h2', { text: ROLE_LABELS[r.role] }), statusChip(r)),
    el('p', { className: 'note', text: ROLE_HINTS[r.role] }),
    selectorList(r),
    actions,
    editing && state.editor ? editorView(state.editor) : null,
  );
}

function render(): void {
  const report = state.report;
  if (!report) {
    app.replaceChildren(
      el('header', {}, el('h1', { text: 'Wtv selectors' }), button('Refresh', refresh)),
      el('p', { className: 'note', text: state.error ?? 'Loading…' }),
    );
    return;
  }

  const kind =
    report.profileKind === 'bundled'
      ? `Built-in: ${report.siteName ?? report.siteId}`
      : report.profileKind === 'user'
        ? 'Your config'
        : 'Generic';

  const footerActions = el('div', { className: 'actions' }, button('Copy site config JSON', copyJson));
  if (DEV_TOOLS) footerActions.append(button('Write to repo…', writeToRepo));

  const parts: (Node | null)[] = [
    el('header', {}, el('h1', { text: report.host }), el('span', { className: 'chip', text: kind }), button('Refresh', refresh)),
    report.profileKind === 'generic'
      ? el('p', {
          className: 'note',
          text: `No site config here. Saving a selector creates one for ${report.host.replace(/^www\./, '')}.`,
        })
      : null,
    state.message ? el('p', { className: 'warn', text: state.message }) : null,
    ...report.roles.map(roleView),
    el(
      'footer',
      {},
      el('p', {
        className: 'note',
        text: 'Saved selectors apply only in this browser until a Wtv update ships a fix. Copy the JSON to share a fix.',
      }),
      footerActions,
    ),
  ];
  app.replaceChildren(...parts.filter((p): p is Node => p !== null));
}

void refresh();
