import './style.css';
import { browser } from 'wxt/browser';
import { browserAreas } from '../../lib/browser-storage';
import { injectIntoTab } from '../../lib/injection';
import { MSG_STATUS, type MediaStatus } from '../../lib/messages';
import { isWebUrl, originPatternForHost } from '../../lib/permissions';
import { BUNDLED_SITES } from '../../lib/sites/bundled';
import { loadOverrideStore } from '../../lib/sites/override-store';
import { profileForHost } from '../../lib/sites/registry';

const app = document.getElementById('app') as HTMLElement;

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

async function mediaStatus(tabId: number): Promise<MediaStatus | null> {
  try {
    return (await browser.tabs.sendMessage(tabId, { type: MSG_STATUS }, { frameId: 0 })) as MediaStatus;
  } catch {
    return null; // No agent in this tab.
  }
}

function describeMedia(status: MediaStatus | null, running: boolean): Node[] {
  if (!status) {
    return [
      el('div', {
        text: running ? 'Wtv isn’t running in this tab yet. Reload the page.' : 'Not active on this page.',
        className: 'note',
      }),
    ];
  }
  const nodes: Node[] = [];
  const p = status.primary;
  if (!p) {
    nodes.push(el('div', { text: `No media detected yet (${status.candidates} candidates).`, className: 'note' }));
  } else {
    const what = p.isVideo ? 'Video' : 'Audio';
    const state = p.playing ? 'playing' : 'paused';
    const how = p.source === 'config' ? 'matched site selector' : 'detected by heuristics';
    const length = p.live ? 'live' : p.duration !== null ? `${Math.round(p.duration)}s` : 'unknown length';
    nodes.push(el('div', { text: `${what}, ${state}${p.muted ? ', muted' : ''} · ${length}` }));
    nodes.push(el('div', { text: `${how}${p.kind === 'bridged' ? ' (via page hook)' : ''}`, className: 'note' }));
  }
  if (status.configVideoMissing) {
    nodes.push(
      el('div', {
        text: 'This site’s video selectors didn’t match anything. Detection is falling back to heuristics; the selectors may be broken.',
        className: 'warn',
      }),
    );
  }
  for (const e of status.selectorErrors) nodes.push(el('div', { text: e, className: 'warn' }));
  return nodes;
}

async function render(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !isWebUrl(tab.url)) {
    app.replaceChildren(el('h1', { text: 'Wtv' }), el('div', { text: 'Wtv only runs on web pages.', className: 'note' }));
    return;
  }
  const tabId = tab.id;
  const host = new URL(tab.url).hostname;
  const pattern = originPatternForHost(host);

  const [overrides, granted, status] = await Promise.all([
    loadOverrideStore(browserAreas().local),
    browser.permissions.contains({ origins: [pattern] }),
    mediaStatus(tabId),
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
      notes.push(el('div', { text: 'Disabling takes full effect after the page reloads.', className: 'note' }));
    }
  } else {
    if (profile.kind === 'bundled') {
      notes.push(
        el('div', {
          text: 'Site access for Wtv is turned off for this site in Chrome’s extension settings.',
          className: 'warn',
        }),
      );
    }
    actions.append(
      // The background injects into open tabs when the grant lands (permissions.onAdded).
      button('Enable on this site', async () => {
        await browser.permissions.request({ origins: [pattern] });
      }, true),
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
    row('Media', ...describeMedia(status, granted)),
  );
}

void render();
