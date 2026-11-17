/**
 * Dev builds only (top frame): a big "Snapshot" button at the top right of the viewport,
 * on the sites it's turned on for (popup → Dev → "Snapshot button on this site"), that saves everything needed to debug a short-lived page state (a new ad format, say)
 * after it's gone, as one JSON file in Downloads:
 *
 *   - `html`: the whole DOM as it is at the click, open shadow roots included
 *     (`<template shadowrootmode="open">`). Scripts' contents are kept.
 *   - `layout`: every rendered element over the player / video / pre-ad video areas,
 *     with its box and the computed styles that decide what's on top.
 *   - `probe`: the ad probe (what's under the overlay, everything saying "skip").
 *   - `media`, `ads`: the same status the popup shows.
 *   - `screenshot`: a PNG of the tab with our overlay hidden, as a data URL, when Chrome
 *     allows it (see screenshot.ts: click the toolbar icon once on the tab).
 *
 * The DOM, layout and probe are taken synchronously on pointerdown, before anything else
 * can change; the screenshot follows a couple of frames later.
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { browser } from 'wxt/browser';
import { WTV_UI_ATTR, deepElements, intersects, ownText, rectLabel, type ProbeArea } from '../ads/probe';
import { describeElement } from '../ads/skip';
import type { AdWatcher } from '../ads/watcher';
import type { MediaAgent } from '../media/agent';
import { onRestacked } from '../overlay/top-layer';
import { DEV_SCREENSHOT, type ScreenshotReply } from './messages';
import { SNAPSHOT_HOSTS_KEY, parseSnapshotHosts } from './snapshot-hosts';
import { timeline } from './timeline';

/** Elements kept in `layout`; the rest are counted. */
const LAYOUT_MAX = 4000;
const SLOP = 24;

interface LayoutEntry {
  path: string;
  rect: string;
  display: string;
  visibility: string;
  opacity: string;
  position: string;
  zIndex: string;
  pointerEvents: string;
  text?: string;
}

/** A few ancestors, enough to find an element in the HTML: div#a > div.b > button.c */
function pathOf(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n && parts.length < 4; n = n.parentElement) parts.unshift(describeElement(n));
  return parts.join(' > ');
}

/** The whole document as HTML, with open shadow roots serialized inline. */
function serializeDom(): string {
  const root = document.documentElement;
  const shadowRoots: ShadowRoot[] = [];
  for (const el of deepElements(document)) if (el.shadowRoot) shadowRoots.push(el.shadowRoot);
  const attrs = [...root.attributes].map((a) => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join('');
  let inner: string;
  try {
    inner = root.getHTML({ serializableShadowRoots: true, shadowRoots });
  } catch {
    inner = root.innerHTML;
  }
  return `<!doctype html>\n<html${attrs}>${inner}</html>`;
}

function layoutOf(areas: readonly ProbeArea[]): { entries: LayoutEntry[]; omitted: number } {
  const entries: LayoutEntry[] = [];
  let omitted = 0;
  for (const el of deepElements(document)) {
    if (el.hasAttribute(WTV_UI_ATTR)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || !areas.some((a) => intersects(r, a.rect, SLOP))) continue;
    if (entries.length >= LAYOUT_MAX) {
      omitted++;
      continue;
    }
    const cs = getComputedStyle(el);
    const text = ownText(el).slice(0, 80);
    entries.push({
      path: pathOf(el),
      rect: rectLabel(r),
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      position: cs.position,
      zIndex: cs.zIndex,
      pointerEvents: cs.pointerEvents,
      ...(text ? { text } : {}),
    });
  }
  return { entries, omitted };
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export function startSnapshotButton(ctx: ContentScriptContext, agent: MediaAgent, ads: AdWatcher): void {
  if (window !== window.top) return;
  const { signal } = ctx;
  let host: HTMLDivElement | null = null;
  let toast: HTMLDivElement | null = null;
  let busy = false;
  let count = 0;

  function say(text: string): void {
    if (toast) toast.textContent = text;
  }

  async function snapshot(): Promise<void> {
    if (busy) return;
    busy = true;
    const takenAt = new Date();
    try {
      // Everything from the page first, in this task, before it can change.
      const probed = ads.probeNow();
      const areas = probed?.areas ?? [];
      const html = serializeDom();
      const layout = layoutOf(areas);
      const data = {
        takenAt: takenAt.toISOString(),
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
        areas: areas.map((a) => ({ name: a.name, rect: rectLabel(a.rect) })),
        media: agent.status(),
        ads: ads.status(),
        probe: probed?.probe ?? null,
        timeline: timeline(),
        layout: layout.entries,
        layoutOmitted: layout.omitted,
        screenshot: null as string | null,
        screenshotError: null as string | null,
        html,
      };
      say('Captured the page; taking a screenshot…');

      // Then the screenshot, with our overlay (and this button) out of the way.
      const ours = [...document.querySelectorAll<HTMLElement>(`[${WTV_UI_ATTR}]`)];
      const before = ours.map((el) => el.style.visibility);
      for (const el of ours) el.style.visibility = 'hidden';
      try {
        await nextFrame();
        await nextFrame();
        const reply = (await browser.runtime.sendMessage({ type: DEV_SCREENSHOT })) as ScreenshotReply | undefined;
        if (reply?.ok) data.screenshot = reply.dataUrl;
        else data.screenshotError = reply?.error ?? 'no answer from the background';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        data.screenshotError = /context invalidated/i.test(message)
          ? 'the extension was reloaded after this tab loaded: reload the tab'
          : message;
      } finally {
        ours.forEach((el, i) => (el.style.visibility = before[i] ?? ''));
      }

      const stamp = takenAt.toISOString().replace(/[:.]/g, '-');
      const name = `wtv-snapshot-${location.hostname.replace(/^www\./, '')}-${stamp}.json`;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      host?.shadowRoot?.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      count++;
      const shot = data.screenshot
        ? 'with a screenshot'
        : data.screenshotError?.startsWith('the extension was reloaded')
          ? `no screenshot: ${data.screenshotError}`
          : 'no screenshot (click the Wtv toolbar icon once on this tab to allow them)';
      say(`#${count} saved to Downloads: ${name}, ${shot}`);
      console.info(`[wtv] snapshot saved: ${name}`, { screenshotError: data.screenshotError });
    } catch (err) {
      say(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[wtv] snapshot failed:', err);
    } finally {
      busy = false;
    }
  }

  function raise(): void {
    if (!host?.isConnected) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Ignore: not connected.
    }
  }

  function mount(): void {
    if (!enabled || host?.isConnected || !document.documentElement || signal.aborted) return;
    host = document.createElement('div');
    host.setAttribute(WTV_UI_ATTR, '');
    host.popover = 'manual';
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'inset: 12px 12px auto auto',
      'margin: 0',
      'padding: 0',
      'border: 0',
      'background: transparent',
      'overflow: visible',
      'z-index: 2147483647',
      // Here, not in :host: the inline `all: initial` would override it.
      'display: flex',
      'flex-direction: column',
      'align-items: flex-end',
      'gap: 6px',
    ].join(';');
    // Open, so the download anchor can be appended to it later. Dev builds only.
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      button {
        all: initial; cursor: pointer; padding: 14px 22px; border-radius: 12px;
        background: #ff2bd6; color: #fff; font: 700 18px/1 system-ui, sans-serif;
        box-shadow: 0 4px 16px rgb(0 0 0 / 0.45);
      }
      button:active { transform: translateY(1px); filter: brightness(0.9); }
      div {
        all: initial; max-width: 360px; padding: 6px 10px; border-radius: 8px;
        background: rgb(0 0 0 / 0.75); color: #fff; font: 12px/1.4 system-ui, sans-serif;
      }
      div:empty { display: none; }
    `;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '📸 Snapshot';
    button.title = 'Wtv dev: save the DOM, layout, ad probe and a screenshot';
    toast = document.createElement('div');
    root.append(style, button, toast);
    // Keep the page from seeing these clicks (players pause / open menus on them).
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      button.addEventListener(type, (e) => e.stopPropagation());
    }
    // pointerdown, not click: capture before the press itself can change anything.
    button.addEventListener('pointerdown', (e) => {
      if (e.button === 0) void snapshot();
    });
    document.documentElement.append(host);
    raise();
  }

  let enabled = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function setEnabled(on: boolean): void {
    if (on === enabled || (on && signal.aborted)) return;
    enabled = on;
    if (on) {
      // The page can replace <html>'s children; come back if it does.
      timer = setInterval(mount, 2000);
      if (document.documentElement) mount();
      else document.addEventListener('DOMContentLoaded', mount, { once: true, signal });
    } else {
      clearInterval(timer);
      timer = undefined;
      host?.remove();
      host = toast = null;
    }
  }

  const site = location.hostname;
  const sync = (raw: unknown) => setEnabled(parseSnapshotHosts(raw).includes(site));
  void browser.storage.local
    .get(SNAPSHOT_HOSTS_KEY)
    .then((r) => sync(r[SNAPSHOT_HOSTS_KEY]))
    .catch(() => undefined);
  const onStorageChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && SNAPSHOT_HOSTS_KEY in changes) sync(changes[SNAPSHOT_HOSTS_KEY]?.newValue);
  };
  browser.storage.onChanged.addListener(onStorageChanged);

  const off = onRestacked(raise);
  ctx.onInvalidated(() => {
    off();
    browser.storage.onChanged.removeListener(onStorageChanged);
    setEnabled(false);
  });
}
