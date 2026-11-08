/**
 * Wtv site health check (dev only; never shipped). `npm run health` builds the extension,
 * then runs this with Node's type stripping.
 *
 * For each bundled site (src/sites/*.json) it opens the known URL from targets.json in
 * Playwright's own Chromium with the built extension loaded (Google Chrome dropped
 * --load-extension), lets the video play, and asks the extension itself, through its
 * service worker, for the same media status and role report the popup and side panel
 * use. So the check exercises the real selector engine and media detection, not a copy.
 *
 * Headful, with a persistent profile in .health/profile: run it on a home connection
 * (headless browsers and datacenter IPs get bot walls), and use `npm run health:setup`
 * once to accept cookie consent or sign in.
 *
 * Results go to .health/results/<timestamp>/ (report.json, summary.md, and the page HTML
 * + screenshot for each failing site) and .health/results/latest.md. While an ad shows,
 * each new ad probe result (what's where the show was, see src/lib/ads/probe.ts) is saved
 * with the page HTML as <site>-ad-<n>.json / .html, up to AD_SNAPSHOTS per site, so new
 * ad formats can be studied after they've gone.
 * Exit code: 0 all passed, 1 a site failed, 2 the run itself couldn't start.
 *
 *   --site <id>       only this site (repeatable)
 *   --timeout <s>     how long to wait for playback, per site (default 60; ads extend it)
 *   --setup           open every target and wait for Enter (consent, sign-in); no checks
 *   --keep-open       leave the browser open at the end
 *   --playlists       also open every built-in playlist entry (src/playlists/*.txt) and
 *                     list the gone ones (the `unavailable` role, or YouTube's own
 *                     playabilityStatus). Gone entries are reported, but don't change the
 *                     exit code: they're for whoever maintains the lists.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import {
  MSG_STATUS,
  PICK_ROLES,
  evaluateRun,
  judgeEntry,
  judgeHttp,
  judgePost,
  parseBuiltinFile,
  parseTargets,
  summarize,
  summarizePlaylists,
  type EntryObservation,
  type EntryResult,
  type Observation,
  type Playability,
  type PlaylistResult,
  type RoleLite,
  type SiteResult,
  type Target,
} from './protocol.ts';
import { findPostAdapter } from '../../src/lib/posts/adapters.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXTENSION = join(ROOT, '.output', 'chrome-mv3');
const SITES = join(ROOT, 'src', 'sites');
const PLAYLISTS = join(ROOT, 'src', 'playlists');
const PROFILE = join(ROOT, '.health', 'profile');
const RESULTS = join(ROOT, '.health', 'results');

const POLL_MS = 1000;
/** Ad-free playback needed before the final check (lets the page finish building). */
const SETTLE_MS = 5000;
/** Extra time allowed once an ad has been seen (pre-rolls can be long or stacked). */
const AD_EXTRA_MS = 120_000;
/** Ad snapshots kept per site. */
const AD_SNAPSHOTS = 3;
/** --playlists: how long to watch each entry page for the unavailable message. */
const ENTRY_WAIT_MS = 10_000;
/** --playlists: with YouTube's status known, how long to give the player to show an error anyway. */
const ENTRY_SETTLE_MS = 3000;

/** The slice of the chrome.* API used inside the service worker. */
interface ChromeLite {
  tabs: {
    query(q: object): Promise<{ id?: number; url?: string }[]>;
    sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
  };
  scripting: { getRegisteredContentScripts(): Promise<unknown[]> };
}
declare const chrome: ChromeLite;

interface StatusLite {
  media: { primary: { playing: boolean; source: 'config' | 'heuristic' } | null } | null;
  ads: { active: boolean; probe?: ({ at: number } & Record<string, unknown>) | null } | null;
}

/** Saves the page and the ad probe each time the probe finds something new. */
function adSnapshotter(page: Page, site: string, outDir: string): (probe: StatusLite['ads']) => Promise<void> {
  const seen = new Set<string>();
  return async (ads) => {
    const probe = ads?.probe;
    if (!probe || seen.size >= AD_SNAPSHOTS) return;
    const { at: _at, ...rest } = probe;
    const key = JSON.stringify(rest);
    if (seen.has(key)) return;
    seen.add(key);
    const base = join(outDir, `${site}-ad-${seen.size}`);
    writeFileSync(`${base}.json`, JSON.stringify(probe, null, 2));
    await page
      .content()
      .then((html) => writeFileSync(`${base}.html`, html))
      .catch(() => undefined);
    console.info(`[health] ${site}: ad snapshot ${seen.size} saved (${base}.json)`);
  };
}

function fail(message: string): never {
  console.error(`[health] ${message}`);
  process.exit(2);
}

/** The extension's service worker, re-acquired if Chrome restarted it. */
class Extension {
  private worker: Worker | null = null;
  private readonly context: BrowserContext;
  // No parameter properties: Node's type stripping only removes syntax, it can't transform.
  constructor(context: BrowserContext) {
    this.context = context;
  }

  private async current(): Promise<Worker> {
    const live = this.context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (live) return (this.worker = live);
    return (this.worker = await this.context.waitForEvent('serviceworker', { timeout: 15_000 }));
  }

  /**
   * Runs `call` against the worker. Callers invoke `worker.evaluate` themselves so
   * Playwright infers its argument types from concrete values (a generic pass-through
   * can't satisfy its `Unboxed<Arg>` parameter type).
   */
  async run<R>(call: (worker: Worker) => Promise<R>): Promise<R> {
    try {
      return await call(this.worker ?? (await this.current()));
    } catch {
      // Worker restarted (MV3 workers come and go): one retry on the new one.
      return call(await this.current());
    }
  }

  ask<T>(tabId: number, message: object): Promise<T | null> {
    return this.run((w) =>
      w.evaluate(
        async ({ tabId: id, message: m }) => {
          try {
            return (await chrome.tabs.sendMessage(id, m, { frameId: 0 })) as T;
          } catch {
            return null; // No content script (yet) in that tab.
          }
        },
        { tabId, message },
      ),
    );
  }

  findTab(url: string): Promise<number | null> {
    return this.run((w) =>
      w.evaluate(async (u) => {
        const base = u.split('#')[0];
        const tabs = await chrome.tabs.query({});
        return tabs.find((t) => t.url?.split('#')[0] === base)?.id ?? null;
      }, url),
    );
  }

  async waitForRegistration(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const n = await this.run((w) => w.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length));
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail('the extension never registered its content scripts');
  }
}

function skipSeen(roles: RoleLite[] | null | undefined): boolean {
  return roles?.some((r) => r.role === 'skip' && r.matchedIndex !== null) ?? false;
}

async function observe(
  ext: Extension,
  page: Page,
  site: string,
  target: Target,
  timeoutMs: number,
  outDir: string,
): Promise<Observation> {
  const snapshot = adSnapshotter(page, site, outDir);
  const obs: Observation = {
    site,
    url: target.url,
    finalUrl: null,
    played: false,
    primarySource: null,
    roles: null,
    adSeen: false,
    skipSeen: false,
    error: null,
  };
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const start = Date.now();
    let tabId: number | null = null;
    let playingSince: number | null = null;

    while (Date.now() - start < timeoutMs + (obs.adSeen ? AD_EXTRA_MS : 0)) {
      await page.waitForTimeout(POLL_MS);
      tabId ??= await ext.findTab(page.url());
      if (tabId === null) continue;
      const status = await ext.ask<StatusLite>(tabId, { type: MSG_STATUS });
      if (!status) continue;

      if (status.ads?.active) {
        if (!obs.adSeen) console.info(`[health] ${site}: ad showing, waiting it out`);
        obs.adSeen = true;
        playingSince = null;
        await snapshot(status.ads);
        const report = await ext.ask<{ roles: RoleLite[] }>(tabId, { type: PICK_ROLES });
        if (skipSeen(report?.roles)) obs.skipSeen = true;
        continue;
      }
      if (status.media?.primary?.playing) {
        playingSince ??= Date.now();
        if (Date.now() - playingSince >= SETTLE_MS) {
          obs.played = true;
          break;
        }
      } else {
        playingSince = null;
      }
    }

    obs.finalUrl = page.url();
    if (tabId !== null) {
      const status = await ext.ask<StatusLite>(tabId, { type: MSG_STATUS });
      obs.primarySource = status?.media?.primary?.source ?? null;
      obs.roles = (await ext.ask<{ roles: RoleLite[] }>(tabId, { type: PICK_ROLES }))?.roles ?? null;
    }
  } catch (err) {
    obs.error = err instanceof Error ? err.message.split('\n')[0]! : String(err);
  }
  return obs;
}

/**
 * Open one entry page and judge it: no playback (videos are paused as they start), just
 * the player's own error (the `unavailable` role) and YouTube's playabilityStatus.
 */
async function checkEntry(ext: Extension, page: Page, playlist: string, url: string): Promise<EntryObservation> {
  const obs: EntryObservation = { playlist, url, unavailableSeen: false, playability: null, error: null };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const start = Date.now();
    let tabId: number | null = null;
    while (Date.now() - start < ENTRY_WAIT_MS) {
      await page.waitForTimeout(POLL_MS);
      obs.playability ??= await page
        .evaluate(() => {
          const status = (window as unknown as { ytInitialPlayerResponse?: { playabilityStatus?: { status?: unknown; reason?: unknown } } })
            .ytInitialPlayerResponse?.playabilityStatus;
          for (const v of document.querySelectorAll('video')) v.pause();
          return typeof status?.status === 'string'
            ? { status: status.status, reason: typeof status.reason === 'string' ? status.reason : null }
            : null;
        })
        .catch((): Playability | null => null);
      tabId ??= await ext.findTab(page.url());
      if (tabId !== null) {
        const report = await ext.ask<{ roles: RoleLite[] }>(tabId, { type: PICK_ROLES });
        if (report?.roles.some((r) => r.role === 'unavailable' && r.matchedIndex !== null)) {
          obs.unavailableSeen = true;
          break;
        }
      }
      if (obs.playability && Date.now() - start >= ENTRY_SETTLE_MS) break;
    }
  } catch (err) {
    obs.error = err instanceof Error ? err.message.split('\n')[0]! : String(err);
  }
  return obs;
}

/** `view=card`: does the site's endpoint still know the post? Read as the extension reads it. */
async function checkPost(url: string): Promise<EntryResult> {
  const found = findPostAdapter(url);
  if (!found) return judgePost(url, null, null);
  try {
    const res = await fetch(found.adapter.endpoint(found.canonical), { signal: AbortSignal.timeout(15_000) });
    return judgePost(url, found.adapter.read(res.status, await res.text(), found.canonical), null);
  } catch (err) {
    return judgePost(url, null, err instanceof Error ? err.message : String(err));
  }
}

/** `view=read` / `scroll`: does the page still load? */
async function checkPage(page: Page, url: string): Promise<EntryResult> {
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return judgeHttp(url, res?.status() ?? null, null);
  } catch (err) {
    return judgeHttp(url, null, err instanceof Error ? err.message.split('\n')[0]! : String(err));
  }
}

async function checkPlaylists(ext: Extension, context: BrowserContext): Promise<PlaylistResult[]> {
  const files = readdirSync(PLAYLISTS)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => parseBuiltinFile(f.replace(/\.txt$/, ''), readFileSync(join(PLAYLISTS, f), 'utf8')))
    .filter((f) => f.urls.length > 0);
  const page = await context.newPage();
  const results: PlaylistResult[] = [];
  for (const file of files) {
    console.info(`[health] playlist ${file.id}: ${file.urls.length} entries`);
    const entries = [];
    for (const [i, url] of file.urls.entries()) {
      const view = file.views[i] ?? 'video';
      const result =
        view === 'card'
          ? await checkPost(url)
          : view === 'read' || view === 'scroll'
            ? await checkPage(page, url)
            : judgeEntry(await checkEntry(ext, page, file.id, url));
      if (result.verdict !== 'ok') console.info(`[health]   ${result.verdict}: ${url}${result.detail ? ` (${result.detail})` : ''}`);
      entries.push(result);
    }
    results.push({ id: file.id, name: file.name, entries });
  }
  await page.close();
  return results;
}

function loadSiteIds(): string[] {
  return readdirSync(SITES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function loadTargets(): Record<string, Target> {
  const { targets, errors } = parseTargets(JSON.parse(readFileSync(new URL('./targets.json', import.meta.url), 'utf8')));
  if (errors.length > 0) fail(`targets.json: ${errors.join('; ')}`);
  return targets;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: 'string', multiple: true },
      timeout: { type: 'string', default: '60' },
      setup: { type: 'boolean', default: false },
      'keep-open': { type: 'boolean', default: false },
      playlists: { type: 'boolean', default: false },
    },
  });
  if (!existsSync(join(EXTENSION, 'manifest.json'))) fail(`no build at ${EXTENSION}; run "npm run health" (it builds first)`);

  const targets = loadTargets();
  const wanted = values.site?.length ? values.site : loadSiteIds();
  const timeoutMs = Math.max(10, Number(values.timeout) || 60) * 1000;

  mkdirSync(PROFILE, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      // A health check shouldn't fail on Chrome's autoplay policy.
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ext = new Extension(context);
  await ext.waitForRegistration();

  if (values.setup) {
    for (const site of wanted) {
      const t = targets[site];
      if (t) await (await context.newPage()).goto(t.url).catch(() => undefined);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('[health] Accept consent / sign in in the open tabs, then press Enter to save the profile… ');
    rl.close();
    await context.close();
    return;
  }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outDir = join(RESULTS, stamp);
  mkdirSync(outDir, { recursive: true });

  const results: SiteResult[] = [];
  for (const site of wanted) {
    const target = targets[site];
    if (!target) {
      results.push({
        site,
        url: '',
        ok: false,
        played: false,
        adSeen: false,
        roles: [],
        problems: ['no target URL in scripts/health/targets.json'],
      });
      continue;
    }
    console.info(`[health] ${site}: ${target.url}`);
    const page = await context.newPage();
    const result = evaluateRun(await observe(ext, page, site, target, timeoutMs, outDir));
    results.push(result);
    console.info(`[health] ${site}: ${result.ok ? 'pass' : `FAIL: ${result.problems.join('; ')}`}`);
    if (!result.ok) {
      // Everything needed to fix the selectors offline.
      await page
        .content()
        .then((html) => writeFileSync(join(outDir, `${site}.html`), html))
        .catch(() => undefined);
      await page.screenshot({ path: join(outDir, `${site}.png`) }).catch(() => undefined);
    }
    if (!values['keep-open']) await page.close();
  }

  const playlists = values.playlists ? await checkPlaylists(ext, context) : null;

  let summary = summarize(results, startedAt.toISOString());
  if (playlists) summary += `\n${summarizePlaylists(playlists)}`;
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify({ startedAt: startedAt.toISOString(), results, ...(playlists ? { playlists } : {}) }, null, 2),
  );
  writeFileSync(join(outDir, 'summary.md'), summary);
  writeFileSync(join(RESULTS, 'latest.md'), summary);
  console.info(`\n${summary}\n[health] results: ${outDir}`);

  if (!values['keep-open']) await context.close();
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
