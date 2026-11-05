import './style.css';
import { browser } from 'wxt/browser';
import { browserAreas } from '../../lib/browser-storage';
import { injectIntoTab } from '../../lib/injection';
import { MSG_STATUS, type AdStatus, type FrameStatus, type MediaStatus } from '../../lib/messages';
import { isWebUrl, originPatternForHost } from '../../lib/permissions';
import { parseSettings, type Settings } from '../../lib/settings';
import { BUNDLED_SITES } from '../../lib/sites/bundled';
import { loadOverrideStore } from '../../lib/sites/override-store';
import { profileForHost } from '../../lib/sites/registry';
import { KEYS, readKey, writeKey } from '../../lib/storage';

const app = document.getElementById('app') as HTMLElement;
const local = browserAreas().local;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; className?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className) node.className = props.className;
  node.append(...children);
  return node;
}

function row(label: string, ...content: Node[]): HTMLElement {
  return el('div', { className: 'row' }, el('div', { className: 'label', text: label }), ...content);
}

function note(text: string, className = 'note'): HTMLElement {
  return el('div', { text, className });
}

function button(text: string, onClick: () => Promise<void>, primary = false): HTMLButtonElement {
  const b = el('button', { text, className: primary ? 'primary' : '' });
  b.type = 'button';
  b.addEventListener('click', () => {
    b.disabled = true;
    onClick()
      .catch((err: unknown) => console.error('[wtv] popup action failed:', err))
      .finally(() => void render());
  });
  return b;
}

async function loadSettings(): Promise<Settings> {
  return parseSettings(await readKey<unknown>(local, KEYS.settings, undefined));
}

function toggle(label: string, key: keyof Settings, settings: Settings): HTMLElement {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = settings[key];
  input.addEventListener('change', () => {
    void (async () => {
      const current = await loadSettings();
      await writeKey(local, KEYS.settings, { ...current, [key]: input.checked });
      setTimeout(() => void render(), 300);
    })();
  });
  return el('label', { className: 'toggle' }, input, document.createTextNode(label));
}

async function frameStatus(tabId: number): Promise<FrameStatus | null> {
  try {
    return (await browser.tabs.sendMessage(tabId, { type: MSG_STATUS }, { frameId: 0 })) as FrameStatus;
  } catch {
    return null; // No agent in this tab.
  }
}

function describeMedia(status: MediaStatus | null, running: boolean): Node[] {
  if (!status) {
    return [note(running ? 'Wtv isn’t running in this tab yet. Reload the page.' : 'Not active on this page.')];
  }
  const nodes: Node[] = [];
  const p = status.primary;
  if (!p) {
    nodes.push(note(`No media detected yet (${status.candidates} candidates).`));
  } else {
    const what = p.isVideo ? 'Video' : 'Audio';
    const state = p.playing ? 'playing' : 'paused';
    const how = p.source === 'config' ? 'matched site selector' : 'detected by heuristics';
    const length = p.live ? 'live' : p.duration !== null ? `${Math.round(p.duration)}s` : 'unknown length';
    nodes.push(el('div', { text: `${what}, ${state}${p.muted ? ', muted' : ''} · ${length}` }));
    nodes.push(note(`${how}${p.kind === 'bridged' ? ' (via page hook)' : ''}`));
  }
  if (status.configVideoMissing) {
    nodes.push(
      note(
        'This site’s video selectors didn’t match anything. Detection is falling back to heuristics; the selectors may be broken.',
        'warn',
      ),
    );
  }
  for (const e of status.selectorErrors) nodes.push(note(e, 'warn'));
  return nodes;
}

function describeAds(ads: AdStatus | null, tabMuted: boolean): Node[] {
  if (!ads) return [note('No ad detection for this site.')];
  const nodes: Node[] = [];
  if (ads.active) {
    nodes.push(el('div', { text: ads.muteAds && tabMuted ? 'Ad playing · tab muted' : 'Ad playing' }));
  } else {
    nodes.push(note('No ad playing.'));
  }
  if (ads.skipClicks > 0) nodes.push(note(`Skip clicked ${ads.skipClicks}× on this page.`));
  for (const e of ads.selectorErrors) nodes.push(note(e, 'warn'));
  return nodes;
}

async function render(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const settings = await loadSettings();
  const settingsRow = row(
    'Settings',
    toggle('Mute ads', 'muteAds', settings),
    toggle('Auto-skip ads', 'autoSkip', settings),
  );

  if (!tab?.id || !isWebUrl(tab.url)) {
    app.replaceChildren(el('h1', { text: 'Wtv' }), note('Wtv only runs on web pages.'), settingsRow);
    return;
  }
  const tabId = tab.id;
  const host = new URL(tab.url).hostname;
  const pattern = originPatternForHost(host);

  const [overrides, granted, status] = await Promise.all([
    loadOverrideStore(local),
    browser.permissions.contains({ origins: [pattern] }),
    frameStatus(tabId),
  ]);
  const profile = profileForHost(host, BUNDLED_SITES, overrides);

  let support: string;
  if (profile.kind === 'bundled') support = `Built-in support: ${profile.site.config.name}`;
  else if (profile.kind === 'user') support = `Custom site config: ${profile.site.config.name}`;
  else support = granted ? 'Enabled (generic detection)' : 'Not enabled on this site';

  const actions = el('div', { className: 'actions' });
  const notes: Node[] = [];

  if (granted) {
    if (profile.kind !== 'bundled') {
      actions.append(
        button('Disable on this site', async () => {
          await browser.permissions.remove({ origins: [pattern] });
        }),
      );
      notes.push(note('Disabling takes full effect after the page reloads.'));
    }
  } else {
    if (profile.kind === 'bundled') {
      notes.push(note('Site access for Wtv is turned off for this site in Chrome’s extension settings.', 'warn'));
    }
    actions.append(
      // The background injects into open tabs when the grant lands (permissions.onAdded).
      button(
        'Enable on this site',
        async () => {
          await browser.permissions.request({ origins: [pattern] });
        },
        true,
      ),
      button('Just this tab', async () => {
        await injectIntoTab(tabId, false);
        await new Promise((r) => setTimeout(r, 400));
      }),
    );
  }

  app.replaceChildren(
    el('h1', { text: host }),
    el('div', { text: support }),
    ...(actions.childElementCount > 0 ? [actions] : []),
    ...notes,
    row('Media', ...describeMedia(status?.media ?? null, granted)),
    ...(status ? [row('Ads', ...describeAds(status.ads, Boolean(tab.mutedInfo?.muted)))] : []),
    settingsRow,
  );
}

void render();
