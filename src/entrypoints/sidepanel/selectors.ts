/**
 * The side panel's Selectors view: inspect each role's selectors on the current tab, pick
 * elements to generate new ones, test them live, remove ones that don't match, and save
 * the result as local overrides. A Preview shows the metadata Wtv reads from the page.
 * Roles come in groups (picker/roles.ts); the Posts group has a card preview: the post
 * card this page would make (for `view=card` entries read from the page).
 * Dev builds can also write the resulting site config straight into src/sites/.
 * Off any site (Wtv not on the page), it lists every site's saved selectors, exports and
 * imports them all as one file, and (dev builds) writes such a file into src/sites/.
 *
 * Only talks to the page while it's the view showing (showSelectors / hideSelectors).
 */
import { browser } from 'wxt/browser';
import { browserAreas } from '../../lib/browser-storage';
import { DEV_TOOLS } from '../../lib/env';
import { getKv, setKv } from '../../lib/images/db';
import {
  META_FIELDS,
  META_ROLES,
  META_SOURCE_LABELS,
  type MetaField,
  type PageMetadata,
} from '../../lib/metadata/extract';
import {
  PICK_CANCEL,
  PICK_CANCELLED,
  PICK_KEY,
  PICK_METADATA,
  PICK_POST,
  PICK_PREVIEW,
  PICK_RESULT,
  PICK_ROLES,
  PICK_START,
  PICK_TEST,
  type Candidate,
  type PagePostReport,
  type PickKey,
  type PickResult,
  type PreviewResult,
  type RoleReport,
  type RolesReport,
  type TestResult,
} from '../../lib/picker/messages';
import { ROLE_GROUPS, ROLE_HINTS, ROLE_LABELS } from '../../lib/picker/roles';
import { siteConfigToJson } from '../../lib/picker/serialize';
import { BUNDLED_SITES } from '../../lib/sites/bundled';
import { loadOverrideStore, saveOverrideStore } from '../../lib/sites/override-store';
import {
  makeSelectorsFile,
  parseSelectorsFile,
  planRepoWrite,
  planSelectorsImport,
  selectorsFileName,
  type RepoPlan,
  type SelectorsImportPlan,
} from '../../lib/sites/selectors-file';
import {
  resolveSite,
  withRoleOverride,
  withQuirk,
  withSelectorsRemoved,
  withoutRoleOverride,
  type OverrideStore,
  type SiteOverride,
} from '../../lib/sites/overrides';
import { CONDITIONS, POST_ROLES, ROLE_DEFAULT_WHEN, USER_QUIRKS, type UserQuirk, type Condition, type Matcher, type RoleName } from '../../lib/sites/schema';
import { validateMatchers } from '../../lib/sites/validate';

const app = document.getElementById('selectors') as HTMLElement;
const local = browserAreas().local;
const KV_REPO_SITES = 'repoSitesHandle';
const PICK_DELAY_MS = 5000;
const PREVIEW_POLL_MS = 3000;
/** Roles that only match while something is happening (an ad, a dialog). */
const TRANSIENT_ROLES: readonly RoleName[] = ['adIndicator', 'skip', 'continuePrompt', 'unavailable'];
const isMetaRole = (role: RoleName) => (META_ROLES as readonly string[]).includes(role);

interface Editor {
  role: RoleName;
  element: string | null;
  candidates: Candidate[];
  selector: string;
  when: Condition | null;
  keepExisting: boolean;
  test: TestResult | null;
}

/** Waiting for a yes: an import into this browser, or (dev) a write into the repo. */
type Pending =
  | { kind: 'import'; file: string; sites: OverrideStore; plan: SelectorsImportPlan; warnings: string[] }
  | { kind: 'repo'; file: string; sites: OverrideStore; warnings: string[]; dir: FileSystemDirectoryHandle | null; plan: RepoPlan | null };

/** This view is showing. */
let active = false;

const state: {
  tabId: number | null;
  frameId: number;
  report: RolesReport | null;
  error: string | null;
  picking: RoleName | null;
  editor: Editor | null;
  message: string | null;
  /** The role whose "Remove unmatched" is waiting for a yes. */
  confirmRemove: RoleName | null;
  /** The last removal, until something else changes the overrides. */
  undo: { siteId: string; before: SiteOverride | undefined; label: string } | null;
  metadata: PageMetadata | null;
  post: PagePostReport | null;
  /** The site's switches as they apply now (built in + yours). */
  quirks: Partial<Record<UserQuirk, boolean>>;
  /** Every site's saved selectors (listed when Wtv isn't on the page). */
  allSites: OverrideStore;
  pending: Pending | null;
} = {
  tabId: null,
  frameId: 0,
  report: null,
  error: null,
  picking: null,
  editor: null,
  message: null,
  confirmRemove: null,
  undo: null,
  metadata: null,
  post: null,
  quirks: {},
  allSites: {},
  pending: null,
};

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

/** The top frame, whatever frame the last pick happened in. */
async function toTop<T>(message: unknown): Promise<T> {
  if (state.tabId === null) throw new Error('No tab');
  return (await browser.tabs.sendMessage(state.tabId, message, { frameId: 0 })) as T;
}

function toAllFrames(message: unknown): void {
  if (state.tabId !== null) browser.tabs.sendMessage(state.tabId, message).catch(() => undefined);
}

async function refresh(): Promise<void> {
  state.tabId = await activeTabId();
  try {
    state.report = await toFrame<RolesReport>({ type: PICK_ROLES });
    state.error = null;
    const { siteId, bundled } = siteIdentity(state.report);
    const store = await loadOverrideStore(local);
    state.quirks = resolveSite(siteId, bundled, store[siteId])?.config.quirks ?? {};
  } catch {
    state.report = null;
    state.error = 'Wtv isn’t running on this page. Enable it from the toolbar popup, or reload the page.';
    state.allSites = await loadOverrideStore(local);
  }
  render();
  await refreshPreview();
  await refreshPostPreview();
}

// --- picking / testing / saving -----------------------------------------------------------

function startPick(role: RoleName, delayMs: number): void {
  state.frameId = 0;
  state.undo = null;
  state.confirmRemove = null;
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
  const { selector, when } = ed;
  let test: TestResult;
  try {
    test = await toFrame<TestResult>({ type: PICK_TEST, role: ed.role, selector, when, reveal: false });
  } catch {
    test = { count: 0, satisfied: false, error: 'Could not reach the page.' };
  }
  // Typed on since: that newer test is coming.
  if (state.editor !== ed || ed.selector !== selector || ed.when !== when) return;
  ed.test = test;
  // In place: a full render rebuilds the input (losing its undo history) mid-typing.
  if (testBox?.isConnected) fillTestResult(testBox, ed);
  else render();
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
  state.undo = null;
  state.message = `Saved ${ROLE_LABELS[ed.role].toLowerCase()} selector for ${siteId}.`;
  // Let the content script pick up the storage change before re-reading.
  setTimeout(() => void refresh(), 400);
}

const QUIRK_TEXT: Record<UserQuirk, { label: string; hint: string }> = {
  noAds: {
    label: 'No ads on this site',
    hint: 'Ad detection stays off here, even with ad selectors: no muting, skipping or ad pictures.',
  },
  startsItself: {
    label: 'Videos start by themselves',
    hint: 'In a playlist, Wtv waits for the video to start instead of pressing play. Start / Next still show if nothing plays.',
  },
};

async function setQuirk(key: UserQuirk, value: boolean): Promise<void> {
  if (!state.report) return;
  const { siteId, bundled } = siteIdentity(state.report);
  const store = await loadOverrideStore(local);
  await saveOverrideStore(
    local,
    withQuirk(store, bundled, siteId, key, value, {
      name: store[siteId]?.name ?? state.report.siteName ?? siteId,
      domains: store[siteId]?.domains ?? [siteId],
    }),
  );
  state.quirks = { ...state.quirks, [key]: value };
  state.message = `${QUIRK_TEXT[key].label}: ${value ? 'on' : 'off'} for ${siteId}.`;
  render();
}

function quirksView(): HTMLElement {
  return el(
    'section',
    { className: 'quirks' },
    ...USER_QUIRKS.map((key) => {
      const box = el('input');
      box.type = 'checkbox';
      box.checked = Boolean(state.quirks[key]);
      box.dataset.key = `quirk-${key}`;
      box.addEventListener('change', () => void setQuirk(key, box.checked));
      return el(
        'label',
        { className: 'quirk' },
        box,
        el('span', {}, el('span', { className: 'quirk-label', text: QUIRK_TEXT[key].label }), el('span', { className: 'note', text: QUIRK_TEXT[key].hint })),
      );
    }),
  );
}

async function resetRole(role: RoleName): Promise<void> {
  if (!state.report) return;
  const { siteId } = siteIdentity(state.report);
  const store = await loadOverrideStore(local);
  await saveOverrideStore(local, withoutRoleOverride(store, siteId, role));
  state.undo = null;
  state.confirmRemove = null;
  state.message = `${ROLE_LABELS[role]} reset to the built-in selectors.`;
  setTimeout(() => void refresh(), 400);
}

/** Remove selectors from a role (as an override), keeping the site's previous overrides for Undo. */
async function removeSelectors(role: RoleName, selectors: readonly string[]): Promise<void> {
  if (!state.report || selectors.length === 0) return;
  const { siteId, bundled } = siteIdentity(state.report);
  const store = await loadOverrideStore(local);
  const before = store[siteId] ? structuredClone(store[siteId]) : undefined;
  const next = withSelectorsRemoved(store, bundled, siteId, role, selectors);
  state.confirmRemove = null;
  if (next === store) {
    state.message = 'Nothing to remove.';
    render();
    return;
  }
  await saveOverrideStore(local, next);
  const what = selectors.length === 1 ? `“${selectors[0]}”` : `${selectors.length} selectors`;
  const left = resolveSite(siteId, bundled, next[siteId])?.config.roles[role]?.length ?? 0;
  const off = left === 0 && bundled?.roles[role]?.length ? ` ${ROLE_LABELS[role]} is now off for ${siteId}.` : '';
  state.message = null;
  state.undo = { siteId, before, label: `Removed ${what} from ${ROLE_LABELS[role].toLowerCase()}.${off}` };
  setTimeout(() => void refresh(), 400);
}

async function undoRemove(): Promise<void> {
  const undo = state.undo;
  if (!undo) return;
  const store = await loadOverrideStore(local);
  const next = { ...store };
  if (undo.before) next[undo.siteId] = undo.before;
  else delete next[undo.siteId];
  await saveOverrideStore(local, next);
  state.undo = null;
  state.message = 'Removal undone.';
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

/**
 * Dev only: the repo's src/sites folder, remembered. Asks for it (or for access again)
 * when needed, which takes a click: call it straight from one.
 */
async function repoDir(): Promise<FileSystemDirectoryHandle> {
  if (!DEV_TOOLS) throw new Error('dev builds only'); // Keeps the writer out of the store build.
  let dir = await getKv<FileSystemDirectoryHandle>(KV_REPO_SITES);
  if (dir && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = undefined;
  }
  if (!dir) {
    dir = await window.showDirectoryPicker({ id: 'wtv-repo-sites', mode: 'readwrite' });
    await setKv(KV_REPO_SITES, dir);
  }
  return dir;
}

/** The remembered folder, if Wtv may still use it without asking. */
async function repoDirIfAllowed(): Promise<FileSystemDirectoryHandle | null> {
  if (!DEV_TOOLS) return null;
  const dir = await getKv<FileSystemDirectoryHandle>(KV_REPO_SITES);
  return dir && (await dir.queryPermission({ mode: 'readwrite' })) === 'granted' ? dir : null;
}

async function writeRepoFile(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
  if (!DEV_TOOLS) return;
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

/** Dev only: write <siteId>.json into the repo's src/sites folder. */
async function writeToRepo(): Promise<void> {
  const out = await effectiveConfigJson();
  if (!out) {
    state.message = 'Nothing to write yet: this site has no selectors.';
    render();
    return;
  }
  const dir = await repoDir();
  await writeRepoFile(dir, `${out.siteId}.json`, out.json);
  state.message =
    dir.name === 'sites'
      ? `Wrote sites/${out.siteId}.json. Rebuild to ship it; the local override is dropped automatically once the bundled config matches.`
      : `Wrote ${out.siteId}.json into “${dir.name}” (expected the repo’s src/sites folder).`;
  render();
}

// --- every site's selectors (off any site) ---------------------------------------------------

const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
let onFile: ((file: File) => Promise<void>) | null = null;
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || !onFile) return;
  onFile(file).catch((err: unknown) => {
    state.message = `Failed: ${(err as Error).message}`;
    render();
  });
});

function chooseFile(then: (file: File) => Promise<void>): void {
  onFile = then;
  fileInput.click();
}

async function readSelectorsFile(file: File): Promise<{ sites: OverrideStore; warnings: string[] } | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    state.message = `${file.name} isn’t JSON.`;
    render();
    return null;
  }
  const parsed = parseSelectorsFile(raw);
  if (!parsed.ok) {
    state.message = `${file.name}: ${parsed.error}`;
    render();
    return null;
  }
  return parsed;
}

async function exportAll(): Promise<void> {
  const store = await loadOverrideStore(local);
  const text = `${JSON.stringify(makeSelectorsFile(store), null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: selectorsFileName() }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const n = Object.keys(store).length;
  state.pending = null;
  state.message = `Exported your selectors for ${n} site${n === 1 ? '' : 's'}.`;
  render();
}

function importAll(): void {
  chooseFile(async (file) => {
    const read = await readSelectorsFile(file);
    if (!read) return;
    const plan = planSelectorsImport(await loadOverrideStore(local), read.sites, BUNDLED_SITES);
    state.message = null;
    state.pending = { kind: 'import', file: file.name, ...read, plan };
    render();
  });
}

async function confirmImport(): Promise<void> {
  const p = state.pending;
  if (p?.kind !== 'import') return;
  // Planned again: something may have been saved since.
  const plan = planSelectorsImport(await loadOverrideStore(local), p.sites, BUNDLED_SITES);
  await saveOverrideStore(local, plan.next);
  state.pending = null;
  state.message = `Imported ${plan.changes.length} site${plan.changes.length === 1 ? '’s' : 's’'} selectors. Open each site with this panel to check them: imported roles say “yours”.`;
  await refresh();
}

/** Dev only: write the selectors in a file (reviewed, maybe trimmed) into src/sites. */
function writeFileToRepo(): void {
  chooseFile(async (file) => {
    const read = await readSelectorsFile(file);
    if (!read) return;
    state.message = null;
    state.pending = { kind: 'repo', file: file.name, ...read, dir: null, plan: null };
    const dir = await repoDirIfAllowed();
    if (dir) await planRepo(dir);
    else render();
  });
}

/** The pending repo write, planned against what's in the folder now. */
async function planRepo(dir: FileSystemDirectoryHandle): Promise<void> {
  const p = state.pending;
  if (p?.kind !== 'repo') return;
  const repo: Record<string, string> = {};
  for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (h.kind === 'file' && h.name.endsWith('.json')) repo[h.name] = await (await (h as FileSystemFileHandle).getFile()).text();
  }
  state.pending = { ...p, dir, plan: planRepoWrite(p.sites, repo) };
  render();
}

async function confirmRepoWrite(): Promise<void> {
  const p = state.pending;
  if (p?.kind !== 'repo' || !p.dir || !p.plan) return;
  for (const w of p.plan.writes) await writeRepoFile(p.dir, w.file, w.text);
  const files = p.plan.writes.map((w) => w.file).join(', ');
  state.pending = null;
  state.message = `Wrote ${files} into ${p.dir.name}/. Check them with git diff, then rebuild: once the new build loads, your saved selectors for those roles are dropped, since they’re built in now.`;
  render();
}

function siteSummary(siteId: string, site: SiteOverride): HTMLElement {
  const bundled = BUNDLED_SITES.find((c) => c.id === siteId);
  const stale = new Set(resolveSite(siteId, bundled, site)?.stale.map((s) => s.role));
  const bits = (Object.entries(site.roles) as [RoleName, NonNullable<SiteOverride['roles'][RoleName]>][]).map(([role, ov]) => {
    const label = ROLE_LABELS[role];
    if (stale.has(role)) return `${label} (not applied: the built-in selectors changed)`;
    return ov.matchers.length === 0 ? `${label} (off)` : label;
  });
  for (const q of USER_QUIRKS) {
    const value = site.quirks?.[q];
    if (value !== undefined) bits.push(`${QUIRK_TEXT[q].label}: ${value ? 'on' : 'off'}`);
  }
  return el(
    'li',
    {},
    el('span', { className: 'site-name', text: siteId }),
    el('span', { className: 'chip', text: bundled ? 'built-in site' : 'your site' }),
    el('div', { className: 'note', text: bits.join(' · ') || 'Nothing saved.' }),
  );
}

function bullets(lines: readonly string[], className = ''): HTMLElement | null {
  return lines.length ? el('ul', { className }, ...lines.map((l) => el('li', { text: l }))) : null;
}

function pendingView(p: Pending): HTMLElement {
  const cancel = button('Cancel', () => {
    state.pending = null;
    render();
  });
  const warnings = p.warnings.length
    ? el('details', {}, el('summary', { text: `${p.warnings.length} problem(s) in the file, left out` }), bullets(p.warnings))
    : null;

  if (p.kind === 'import') {
    const { plan } = p;
    const any = plan.changes.length > 0;
    return el(
      'section',
      { className: 'pending' },
      el('p', { text: any ? `Import from ${p.file}:` : `Nothing to import: this browser already has everything in ${p.file}.` }),
      bullets(plan.changes),
      plan.unchanged ? el('p', { className: 'note', text: `${plan.unchanged} role(s) or switch(es) already match.` }) : null,
      plan.skipped.length ? el('p', { className: 'note', text: 'Left out:' }) : null,
      bullets(plan.skipped, 'skipped'),
      warnings,
      el('div', { className: 'actions' }, any ? button('Import', confirmImport, 'primary') : null, cancel),
    );
  }

  if (!DEV_TOOLS) return cancel; // Repo writes are dev only; keeps them out of the store build.
  if (!p.plan) {
    return el(
      'section',
      { className: 'pending' },
      el('p', { text: `To write ${p.file} into the repo, Wtv needs the repo’s src/sites folder.` }),
      el(
        'div',
        { className: 'actions' },
        button('Choose src/sites…', async () => planRepo(await repoDir()), 'primary'),
        cancel,
      ),
    );
  }

  const { plan } = p;
  const writes = plan.writes.map((w) => {
    const what = [...w.roles, ...w.quirks].join(', ');
    return `${w.file}: ${what}${w.isNew ? ' (new built-in site, access optional: turned on from the popup, no install warning)' : ''}`;
  });
  return el(
    'section',
    { className: 'pending' },
    p.dir && p.dir.name !== 'sites' ? el('p', { className: 'warn', text: `“${p.dir.name}” isn’t called sites: is it the repo’s src/sites?` }) : null,
    plan.errors.length
      ? el('p', { className: 'warn', text: 'Nothing written: the build would fail with these changes.' })
      : el('p', { text: plan.writes.length ? `Write ${p.file} into ${p.dir?.name ?? 'the repo'}/:` : `Nothing to write from ${p.file}.` }),
    bullets(plan.errors, 'skipped'),
    bullets(writes),
    plan.skipped.length ? el('p', { className: 'note', text: 'Left out:' }) : null,
    bullets(plan.skipped, 'skipped'),
    warnings,
    el(
      'div',
      { className: 'actions' },
      plan.writes.length ? button(`Write ${plan.writes.length} file${plan.writes.length === 1 ? '' : 's'}`, confirmRepoWrite, 'primary') : null,
      cancel,
    ),
  );
}

function allSitesView(): HTMLElement {
  const sites = Object.keys(state.allSites).sort();
  const exportButton = button('Export all…', exportAll);
  exportButton.disabled = sites.length === 0;
  const actions = el('div', { className: 'actions' }, exportButton, button('Import…', importAll));
  if (DEV_TOOLS) actions.append(button('Write a file to the repo…', writeFileToRepo));
  return el(
    'section',
    { className: 'all-sites' },
    el('h2', { text: 'Your selectors, every site' }),
    sites.length
      ? el('ul', { className: 'site-list' }, ...sites.map((id) => siteSummary(id, state.allSites[id]!)))
      : el('p', { className: 'note', text: 'You haven’t saved any selectors yet.' }),
    actions,
    state.pending ? pendingView(state.pending) : null,
    el('p', {
      className: 'note',
      text: DEV_TOOLS
        ? 'Export all saves them as one file, to import on another computer. To put some into the source, review the exported file, delete what isn’t ready, then Write a file to the repo.'
        : 'Export all saves them as one file, to import on another computer.',
    }),
  );
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

function forgetPage(): void {
  state.editor = null;
  state.frameId = 0;
  state.undo = null;
  state.confirmRemove = null;
  state.metadata = null;
  shownMetadata = '';
}

browser.tabs.onActivated.addListener(() => {
  if (!active) return;
  cancelPick();
  forgetPage();
  void refresh();
});

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (active && tabId === state.tabId && info.status === 'complete') {
    forgetPage();
    void refresh();
  }
});

// --- rendering ---------------------------------------------------------------------------

function statusChip(r: RoleReport): HTMLElement {
  if (r.matchers.length === 0) {
    return el('span', { className: 'chip', text: r.source === 'override' ? 'removed · yours' : 'not set' });
  }
  if (r.matchedIndex === null) return el('span', { className: 'chip bad', text: 'no match' });
  const which = r.matchers.length > 1 ? ` #${r.matchedIndex + 1}` : '';
  return el('span', { className: 'chip ok', text: `matched${which}${r.source === 'override' ? ' · yours' : ''}` });
}

function selectorList(r: RoleReport): HTMLElement | null {
  if (r.matchers.length === 0) return null;
  return el(
    'ul',
    { className: 'selectors' },
    ...r.matchers.map((m, i) => {
      const remove = button('✕', () => removeSelectors(r.role, [m.selector]), 'remove');
      remove.title = 'Remove this selector';
      remove.setAttribute('aria-label', `Remove selector ${m.selector}`);
      remove.disabled = state.picking !== null;
      // Click a selector: its matches outlined in green on the page (scrolled to if need be).
      const show = el('button', { className: 'show' }, el('code', { text: m.selector }));
      show.type = 'button';
      show.title = m.count > 0 ? 'Outline its matches on the page' : 'It matches nothing on the page right now';
      show.disabled = m.count === 0 || m.error !== null;
      show.addEventListener('click', () => {
        void toFrame({ type: PICK_TEST, role: r.role, selector: m.selector, when: m.when, reveal: true }).catch(() => undefined);
      });
      return el(
        'li',
        {},
        el('span', { className: i === r.matchedIndex ? 'hit' : m.satisfied ? '' : 'miss', text: m.satisfied ? '✓' : '✗' }),
        show,
        el('span', { className: 'count', text: m.error ? 'invalid' : `${m.count} · ${m.when}` }),
        remove,
      );
    }),
  );
}

const unmatched = (r: RoleReport) => r.matchers.filter((m) => m.count === 0).map((m) => m.selector);

function confirmRemoveView(r: RoleReport): HTMLElement {
  const list = unmatched(r);
  const all = list.length === r.matchers.length;
  const lines = [
    `Remove ${list.length === 1 ? 'the selector' : `the ${list.length} selectors`} that match nothing on this page right now?`,
  ];
  if (TRANSIENT_ROLES.includes(r.role)) {
    lines.push(
      `${ROLE_LABELS[r.role]} selectors normally match nothing until it shows (during an ad or a dialog), so only do this while it's on screen.`,
    );
  }
  if (all) lines.push(`That's all of them, which turns ${ROLE_LABELS[r.role].toLowerCase()} off for this site.`);
  return el(
    'div',
    { className: 'warn confirm' },
    ...lines.map((text) => el('p', { text })),
    el(
      'div',
      { className: 'actions' },
      button(`Remove ${list.length}`, () => removeSelectors(r.role, list), 'primary'),
      button('Cancel', () => {
        state.confirmRemove = null;
        render();
      }),
    ),
  );
}

/** The open editor's test result: filled in place as the selector is typed. */
let testBox: HTMLElement | null = null;

/**
 * One line of result, plus a fixed-size "Reads" box for roles that read a value. Same
 * size whatever the result, so the panel doesn't jump while a selector is half typed
 * (`div.` is invalid, `div.a` isn't).
 */
function fillTestResult(box: HTMLElement, ed: Editor): void {
  const t = ed.test;
  const line = el('p', { className: 'test-line' });
  if (!ed.selector.trim()) {
    line.textContent = 'Type a selector to test it.';
  } else if (!t) {
    line.textContent = 'Testing…';
  } else if (t.error) {
    line.classList.add('bad');
    line.textContent = t.error.startsWith('invalid selector') ? 'Not a valid selector (yet).' : t.error;
  } else {
    line.textContent = `${t.count} match${t.count === 1 ? '' : 'es'} on the page (outlined in green)${t.satisfied ? '' : ' · condition not met right now'}.`;
  }
  line.title = t?.error ?? line.textContent;

  const readsValue = isMetaRole(ed.role) || (POST_ROLES as readonly RoleName[]).includes(ed.role);
  const reads = readsValue
    ? el('p', {
        className: 'reads',
        text: !t || t.error ? 'Reads: —' : t.value ? `Reads: “${t.value.slice(0, 240)}”` : 'Reads: nothing (no text).',
      })
    : null;
  box.replaceChildren(...(reads ? [line, reads] : [line]));
}

function editorView(ed: Editor): HTMLElement {
  const input = el('input');
  input.type = 'text';
  input.value = ed.selector;
  input.spellcheck = false;
  input.dataset.key = 'selector';
  input.setAttribute('aria-label', 'Selector');
  input.addEventListener('input', () => {
    ed.selector = input.value;
    if (!ed.selector.trim()) {
      ed.test = null;
      if (testBox) fillTestResult(testBox, ed);
    }
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

  testBox = el('div', { className: 'test-result' });
  fillTestResult(testBox, ed);
  const metaNote = isMetaRole(ed.role)
    ? el('p', {
        className: 'note',
        text: 'Once saved, your selector is used ahead of the page’s own data (JSON-LD, OpenGraph, meta tags). See Preview above.',
      })
    : null;

  return el(
    'div',
    { className: 'editor' },
    ed.element ? el('p', { className: 'note', text: `Picked ${ed.element}` }) : null,
    candidates,
    input,
    el('div', { className: 'row' }, when, el('label', { className: 'check' }, keep, document.createTextNode('Keep the current selectors as fallbacks'))),
    testBox,
    metaNote,
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
      state.confirmRemove = null;
      state.editor = { role: r.role, element: null, candidates: [], selector: '', when: null, keepExisting: true, test: null };
      state.frameId = 0;
      focusNext = 'selector';
      render();
    });
    for (const b of [pick, later, type]) b.disabled = busy;
    actions.append(pick, later, type);
    const misses = unmatched(r).length;
    if (misses > 0 && state.confirmRemove !== r.role) {
      const b = button(`Remove unmatched (${misses})`, () => {
        state.confirmRemove = r.role;
        render();
      });
      b.disabled = busy;
      actions.append(b);
    }
    if (r.source === 'override') actions.append(button('Reset', () => resetRole(r.role)));
  }

  return el(
    'section',
    { className: `role${editing ? ' editing' : ''}` },
    el('div', { className: 'role-head' }, el('h2', { text: ROLE_LABELS[r.role] }), statusChip(r)),
    el('p', { className: 'note', text: ROLE_HINTS[r.role] }),
    selectorList(r),
    actions,
    state.confirmRemove === r.role && !picking && unmatched(r).length > 0 ? confirmRemoveView(r) : null,
    editing && state.editor ? editorView(state.editor) : null,
  );
}

// --- metadata preview -------------------------------------------------------------------

const FIELD_LABELS: Record<MetaField, string> = {
  title: 'Title',
  creator: 'Creator',
  description: 'Description',
  keywords: 'Keywords',
  thumbnail: 'Thumbnail',
  duration: 'Duration',
};

/** Kept across renders, so its open state and contents survive; refreshed on its own. */
const previewBox = el('details', { className: 'preview' });
const PREVIEW_OPEN_KEY = 'wtv.previewOpen';
try {
  previewBox.open = localStorage.getItem(PREVIEW_OPEN_KEY) !== '0';
} catch {
  previewBox.open = true;
}
previewBox.addEventListener('toggle', () => {
  try {
    localStorage.setItem(PREVIEW_OPEN_KEY, previewBox.open ? '1' : '0');
  } catch {
    // Not important.
  }
});
/** Fields whose "other values" list is open. */
const openFields = new Set<MetaField>();
let shownMetadata = '';

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function displayValue(field: MetaField, value: string): string {
  return field === 'duration' ? formatDuration(Number(value)) : value;
}

function fieldView(meta: PageMetadata, field: MetaField): HTMLElement {
  const [winner, ...others] = meta.candidates[field];
  const value: Node = !winner
    ? el('span', { className: 'note', text: '—' })
    : field === 'thumbnail'
      ? Object.assign(el('img'), { src: winner.value, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
      : el('span', { className: `value ${field}`, text: displayValue(field, winner.value) });
  let chip: HTMLElement | null = null;
  if (winner) {
    chip = el('span', { className: `chip${winner.source === 'yours' ? ' ok' : ''}`, text: META_SOURCE_LABELS[winner.source] });
    chip.title = winner.detail;
  }

  let more: HTMLDetailsElement | null = null;
  if (others.length > 0) {
    const details = el(
      'details',
      { className: 'others' },
      el('summary', { text: `${others.length} other value${others.length === 1 ? '' : 's'}` }),
      el(
        'ul',
        {},
        ...others.map((c) =>
          el(
            'li',
            {},
            el('span', { className: 'chip', text: `${META_SOURCE_LABELS[c.source]} · ${c.detail}` }),
            el('span', { className: 'value', text: displayValue(field, c.value) }),
          ),
        ),
      ),
    );
    details.open = openFields.has(field);
    details.addEventListener('toggle', () => {
      if (details.open) openFields.add(field);
      else openFields.delete(field);
    });
    more = details;
  }
  return el(
    'div',
    { className: 'field' },
    el('div', { className: 'field-head' }, el('span', { className: 'field-name', text: FIELD_LABELS[field] }), chip),
    value,
    more,
  );
}

function renderPreview(): void {
  const meta = state.metadata;
  const children: (Node | null)[] = [
    el('summary', { text: 'Preview' }),
    el('p', {
      className: 'note',
      text: 'What Wtv reads about this page: your selectors first, then the page’s own data, then the site’s selectors. Hover a source for details.',
    }),
  ];
  if (!meta) {
    children.push(el('p', { className: 'note', text: 'Nothing read yet.' }));
  } else {
    if (meta.staleHead) {
      children.push(
        el('p', {
          className: 'note',
          text: 'This page’s OpenGraph and meta tags describe a page you were on earlier (the site switched pages without reloading), so they’re ignored.',
        }),
      );
    }
    children.push(...META_FIELDS.map((f) => fieldView(meta, f)));
  }
  previewBox.replaceChildren(...children.filter((c): c is Node => c !== null));
}

// --- role groups and the card preview ---------------------------------------------------

/** Groups the user opened or closed (by title); the rest use their default. */
const GROUPS_KEY = 'wtv.selectorGroups';
function loadGroupState(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}');
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
const groupOpen = loadGroupState();

/** Kept across renders, like the metadata preview; refreshed on its own. */
const cardPreview = el('div', { className: 'card-preview' });
let shownPost = '';

/** Shows the card over the page, as a playlist would (✕ or Esc closes it). */
function previewOnPage(): HTMLElement {
  const out = el('span', { className: 'note' });
  const b = button('Preview on the page', async () => {
    b.disabled = true;
    out.textContent = '';
    try {
      const result = await toTop<PreviewResult>({ type: PICK_PREVIEW });
      out.textContent = result?.error ?? '';
    } catch {
      out.textContent = 'Couldn’t reach the page. Reload it and try again.';
    } finally {
      b.disabled = false;
    }
  });
  b.title = 'Show this card over the page the way a playlist would, with ✕ to close it';
  return el('div', { className: 'actions' }, b, out);
}

function renderCardPreview(): void {
  const report = state.post;
  const post = report?.post ?? null;
  if (!post) {
    cardPreview.replaceChildren(
      el('p', {
        className: 'note',
        text: 'Card preview: no post yet. Pick at least the post’s text, title or pictures, on a post’s own page.',
      }),
    );
    return;
  }
  const head = el(
    'div',
    { className: 'card-head' },
    el('span', { className: 'card-author', text: post.author || '(no author)' }),
    post.time ? el('span', { className: 'note', text: post.time }) : null,
  );
  const pics = post.images.length
    ? el(
        'div',
        { className: 'card-pics' },
        ...post.images.map((src) => Object.assign(el('img'), { src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })),
      )
    : null;
  const embed = report?.fields.find((f) => f.role === 'postEmbed')?.value ?? null;
  const parts: (Node | null)[] = [
    el('p', { className: 'field-name', text: 'Card preview' }),
    head,
    post.title ? el('p', { className: 'card-title', text: post.title }) : null,
    post.text ? el('p', { className: 'card-text', text: post.text }) : null,
    embed
      ? el('p', { className: 'note', text: `▶ Plays ${embed} beside the card, on this page (no pictures then).` })
      : pics,
    previewOnPage(),
  ];
  cardPreview.replaceChildren(...parts.filter((p): p is Node => p !== null));
}

async function refreshPostPreview(): Promise<void> {
  if (!state.report) return;
  try {
    state.post = await toTop<PagePostReport>({ type: PICK_POST });
  } catch {
    state.post = null;
  }
  const key = JSON.stringify([state.post?.post ?? null, state.post?.fields.find((f) => f.role === 'postEmbed')?.value ?? null]);
  if (key === shownPost) return;
  shownPost = key;
  renderCardPreview();
}

function groupView(group: (typeof ROLE_GROUPS)[number], roles: RoleReport[]): HTMLElement | null {
  const mine = roles.filter((r) => group.roles.includes(r.role));
  if (mine.length === 0) return null;
  const isPosts = group.roles.includes('postText');
  // Posts: closed until the site has some post selectors (most sites are for watching).
  const fallback = !isPosts || mine.some((r) => r.matchers.length > 0) || group.roles.includes(state.editor?.role ?? 'video');
  const details = el(
    'details',
    { className: 'group' },
    el('summary', { text: group.title }),
    group.note ? el('p', { className: 'note', text: group.note }) : null,
    isPosts ? cardPreview : null,
    ...mine.map(roleView),
  );
  details.open = groupOpen[group.title] ?? fallback;
  details.addEventListener('toggle', () => {
    groupOpen[group.title] = details.open;
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(groupOpen));
    } catch {
      // Not important.
    }
  });
  return details;
}

async function refreshPreview(): Promise<void> {
  if (!state.report) return;
  try {
    state.metadata = await toTop<PageMetadata>({ type: PICK_METADATA });
  } catch {
    state.metadata = null;
  }
  const key = JSON.stringify(state.metadata);
  if (key === shownMetadata) return;
  shownMetadata = key;
  renderPreview();
}

setInterval(() => {
  if (active && document.visibilityState === 'visible' && state.report && !state.picking) {
    void refreshPreview();
    void refreshPostPreview();
  }
}, PREVIEW_POLL_MS);

// --- rendering ---------------------------------------------------------------------------

/** Focus this (a `data-key`) after the next render, scrolling it into view if needed. */
let focusNext: string | null = null;

/**
 * Re-rendering replaces everything: keep the scroll position (Chrome loses it when the
 * whole panel is swapped, jumping to the top), and the focus and caret where they were.
 */
function render(): void {
  const scroller = document.scrollingElement ?? document.documentElement;
  const top = scroller.scrollTop;
  const active = document.activeElement;
  const key = focusNext ?? (active instanceof HTMLElement ? active.dataset.key : undefined);
  const input = !focusNext && active instanceof HTMLInputElement ? active : null;
  const range = input ? ([input.selectionStart, input.selectionEnd] as const) : null;
  const reveal = focusNext !== null;
  focusNext = null;

  draw();
  scroller.scrollTop = top;
  if (!key) return;
  const next = app.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (next instanceof HTMLInputElement && range) next.setSelectionRange(range[0], range[1]);
  if (reveal) next.scrollIntoView({ block: 'nearest' });
}

function draw(): void {
  const report = state.report;
  if (!report) {
    const parts: (Node | null)[] = [
      el('header', {}, el('h1', { text: 'Wtv selectors' }), button('Refresh', refresh)),
      el('p', { className: 'note', text: state.error ?? 'Loading…' }),
      state.message ? el('p', { className: 'warn', text: state.message }) : null,
      state.error ? allSitesView() : null,
    ];
    app.replaceChildren(...parts.filter((p): p is Node => p !== null));
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
    state.undo
      ? el('div', { className: 'warn undo' }, el('span', { text: state.undo.label }), button('Undo', undoRemove))
      : state.message
        ? el('p', { className: 'warn', text: state.message })
        : null,
    quirksView(),
    previewBox,
    ...ROLE_GROUPS.map((g) => groupView(g, report.roles)),
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

export function showSelectors(): void {
  if (active) return;
  active = true;
  void (async () => {
    // Pages and tabs changed unwatched while hidden: keep an edit only on the same tab.
    if ((await activeTabId()) !== state.tabId) forgetPage();
    await refresh();
  })();
}

export function hideSelectors(): void {
  if (!active) return;
  if (state.picking) cancelPick();
  active = false;
}
