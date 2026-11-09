/**
 * In-page element picker UI. DOM-only (content script).
 *
 * - Hover highlights the element under the pointer (through open shadow roots).
 * - Click selects. The page sees none of the pick's events (pointer, mouse, touch, click):
 *   they go through the guard (guard.ts), whose listeners were added before the page's
 *   own, so a page that acts on pointerdown can't open things or eat the click. The pick
 *   is the element pressed on; if the click never arrives, it's taken at pointerup.
 * - Frames Wtv doesn't run in (an embedded player from another site) would take the
 *   pick's click themselves, and nothing here could stop them: while picking they're made
 *   see-through to the pointer, so hover and click land on the element holding them. A
 *   frame Wtv does run in has its own picker and says so (FRAME_LIVE), so it stays live.
 * - ↑ / ↓ walk to the parent / back down. P plays/pauses the primary media (freeze an
 *   ad to pick its parts). Esc cancels.
 * - Optional countdown first, for things that only appear on hover or mid-ad.
 *
 * The UI lives in a closed shadow root on a pointer-events:none popover host, so the
 * page can't restyle it and it never becomes the pick target.
 */

import { GUARDED_EVENTS, setPickGuard } from './guard';

export interface PickerOptions {
  delayMs: number;
  roleLabel: string;
  onPick(el: Element): void;
  onCancel(): void;
  togglePlayback(): void;
}

export interface Picker {
  stop(): void;
  /** Keys forwarded from the side panel (which keeps focus while picking). */
  key(key: 'up' | 'down' | 'toggle' | 'cancel'): void;
}

const CSS_TEXT = `
  :host { all: initial; }
  .box {
    position: fixed; pointer-events: none; box-sizing: border-box;
    border: 2px solid #ff2bd6; background: rgb(255 43 214 / 0.12);
    display: none;
  }
  .tag {
    position: fixed; pointer-events: none; display: none;
    padding: 2px 6px; background: #ff2bd6; color: #fff;
    font: 600 11px/1.4 system-ui, sans-serif; white-space: nowrap;
    max-width: 60vw; overflow: hidden; text-overflow: ellipsis;
  }
  .bar {
    position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
    pointer-events: none; padding: 8px 14px; border-radius: 999px;
    background: rgb(20 20 26 / 0.88); color: #fff;
    font: 500 13px/1.4 system-ui, sans-serif; white-space: nowrap;
  }
  .bar b { color: #ff8ae9; }
  .count {
    position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none;
    font: 800 120px/1 system-ui, sans-serif; color: #fff; text-shadow: 0 4px 24px rgb(0 0 0 / 0.6);
  }
  .hl {
    position: fixed; pointer-events: none; box-sizing: border-box;
    border: 2px dashed #34d399; background: rgb(52 211 153 / 0.12);
  }
`;

function makeHost(): { host: HTMLDivElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; margin: 0; padding: 0; border: 0; background: transparent; width: 100vw; height: 100vh; overflow: visible;';
  host.popover = 'manual';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  root.append(style);
  document.documentElement.append(host);
  try {
    host.showPopover();
  } catch {
    // Older engines: fixed + max z-index still works outside fullscreen.
  }
  return { host, root };
}

function div(className: string, text = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.textContent = text;
  return d;
}

/** After pointerup, how long to wait for the click before picking anyway. */
const CLICK_WAIT_MS = 350;
/** postMessage keys: child frame → parent "my picker is running"; parent → child "is yours?". */
const FRAME_LIVE = 'wtv-picker-live';
const FRAME_ASK = 'wtv-picker-ask';
/** How often to look for iframes added while picking. */
const FRAME_SCAN_MS = 1000;

/** Every <iframe> in the document and its open shadow roots. */
function allFrames(): HTMLIFrameElement[] {
  const out: HTMLIFrameElement[] = [];
  const roots: (Document | ShadowRoot)[] = [document];
  for (let root = roots.pop(); root; root = roots.pop()) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n instanceof HTMLIFrameElement) out.push(n);
      const shadow = (n as Element).shadowRoot;
      if (shadow) roots.push(shadow);
    }
  }
  return out;
}

/**
 * While picking: iframes whose frame has no picker of its own get `pointer-events: none`
 * (put back exactly as it was afterwards). Answers and asks parent / child frames which
 * ones are live. Stops with `signal`.
 */
function shieldFrames(signal: AbortSignal): void {
  const live = new WeakSet<object>();
  const touched = new Map<HTMLIFrameElement, [string, string]>();

  function restore(f: HTMLIFrameElement): void {
    const before = touched.get(f);
    if (!before) return;
    touched.delete(f);
    if (before[0]) f.style.setProperty('pointer-events', before[0], before[1]);
    else f.style.removeProperty('pointer-events');
  }

  function scan(): void {
    for (const f of allFrames()) {
      const win = f.contentWindow;
      if (win && live.has(win)) {
        restore(f);
        continue;
      }
      if (touched.has(f)) continue;
      touched.set(f, [f.style.getPropertyValue('pointer-events'), f.style.getPropertyPriority('pointer-events')]);
      f.style.setProperty('pointer-events', 'none', 'important');
      win?.postMessage({ [FRAME_ASK]: true }, '*');
    }
  }

  window.addEventListener(
    'message',
    (e: MessageEvent<unknown>) => {
      const data = e.data as Record<string, unknown> | null;
      if (typeof data !== 'object' || data === null || !e.source) return;
      if (data[FRAME_LIVE] === true) {
        // A page could send this too; all it gets is its own iframe left clickable.
        live.add(e.source);
        scan();
      } else if (data[FRAME_ASK] === true && e.source === window.parent) {
        window.parent.postMessage({ [FRAME_LIVE]: true }, '*');
      }
    },
    { signal },
  );
  if (window !== window.top) window.parent.postMessage({ [FRAME_LIVE]: true }, '*');
  scan();
  const timer = setInterval(scan, FRAME_SCAN_MS);
  signal.addEventListener('abort', () => {
    clearInterval(timer);
    for (const f of [...touched.keys()]) restore(f);
  });
}

function targetOf(e: Event): Element | null {
  const t = e.composedPath()[0];
  return t instanceof Element ? t : null;
}

export function startPicker(options: PickerOptions): Picker {
  const { host, root } = makeHost();
  const box = div('box');
  const tag = div('tag');
  const bar = div('bar');
  bar.append(
    document.createTextNode('Picking '),
    Object.assign(document.createElement('b'), { textContent: options.roleLabel }),
    document.createTextNode(' · click to select · ↑ parent · ↓ back · P play/pause · Esc cancel'),
  );
  root.append(box, tag, bar);

  let hovered: Element | null = null;
  /** Elements walked past with ↑, so ↓ can come back. */
  let trail: Element[] = [];
  let active = false;
  let countdown: ReturnType<typeof setInterval> | undefined;
  /** Pressed on (pointerdown): picked at the click, or shortly after pointerup without one. */
  let pressed: Element | null = null;
  let clickWait: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const { signal } = controller;

  function show(el: Element | null): void {
    hovered = el;
    if (!el) {
      box.style.display = tag.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const id = el.id ? `#${el.id}` : '';
    const classes = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    tag.textContent = `${el.localName}${id}${classes} · ${Math.round(r.width)}×${Math.round(r.height)}`;
    Object.assign(tag.style, {
      display: 'block',
      left: `${Math.max(0, r.left)}px`,
      top: `${r.top > 22 ? r.top - 22 : r.bottom}px`,
    });
  }

  function stop(): void {
    active = false;
    if (countdown !== undefined) clearInterval(countdown);
    clearTimeout(clickWait);
    setPickGuard(null);
    controller.abort();
    host.remove();
  }

  function pick(el: Element | null): void {
    if (!active || !el) return;
    stop();
    options.onPick(el);
  }

  /** Every guarded event: kept from the page; the press, release and click make the pick. */
  function onGuarded(e: Event): void {
    if (!active) return;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
    const primary = !(e instanceof MouseEvent) || e.button === 0;
    if ((e.type === 'pointerdown' || e.type === 'mousedown' || e.type === 'touchstart') && primary) {
      pressed ??= hovered ?? targetOf(e);
    } else if (e.type === 'click' && primary) {
      pick(hovered ?? pressed ?? targetOf(e));
    } else if ((e.type === 'pointerup' || e.type === 'touchend') && pressed) {
      // The click normally follows at once; if the page made sure it won't, pick anyway.
      clearTimeout(clickWait);
      clickWait = setTimeout(() => pick(pressed), CLICK_WAIT_MS);
    }
  }

  function activate(): void {
    active = true;
    const opts = { capture: true, signal } as const;
    shieldFrames(signal);
    window.addEventListener(
      'pointermove',
      (e) => {
        const t = targetOf(e);
        if (t && t !== hovered) {
          trail = [];
          show(t);
        }
      },
      { ...opts, passive: true },
    );
    // Injected into an already-open page, there's no early guard: listen now (after the
    // page's own window listeners, so less sure, but the pointerup fallback still picks).
    if (!setPickGuard(onGuarded)) {
      for (const type of GUARDED_EVENTS) window.addEventListener(type, onGuarded, opts);
    }
    window.addEventListener('scroll', () => show(hovered), { ...opts, passive: true });
  }

  /** Returns true if the key was handled. */
  function handleKey(k: 'up' | 'down' | 'toggle' | 'cancel'): boolean {
    if (k === 'cancel') {
      stop();
      options.onCancel();
      return true;
    }
    if (!active) return false;
    if (k === 'up' && hovered) {
      const root = hovered.getRootNode();
      const parent = hovered.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      if (parent && parent !== document.documentElement) {
        trail.push(hovered);
        show(parent);
      }
      return true;
    }
    if (k === 'down' && trail.length > 0) {
      show(trail.pop() ?? null);
      return true;
    }
    if (k === 'toggle') {
      options.togglePlayback();
      return true;
    }
    return false;
  }

  const KEYS: Record<string, 'up' | 'down' | 'toggle' | 'cancel'> = {
    Escape: 'cancel',
    ArrowUp: 'up',
    ArrowDown: 'down',
    p: 'toggle',
    P: 'toggle',
  };

  window.addEventListener(
    'keydown',
    (e) => {
      const k = KEYS[e.key];
      if (k && handleKey(k)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true, signal },
  );

  if (options.delayMs > 0) {
    let remaining = Math.ceil(options.delayMs / 1000);
    const count = div('count', String(remaining));
    root.append(count);
    countdown = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        count.textContent = String(remaining);
        return;
      }
      clearInterval(countdown);
      countdown = undefined;
      count.remove();
      activate();
    }, 1000);
  } else {
    activate();
  }

  return {
    stop,
    key(k) {
      handleKey(k);
    },
  };
}

/** Briefly outline every element in `elements` (selector test feedback). */
export function flashMatches(elements: readonly Element[], ms = 2500): void {
  if (elements.length === 0) return;
  const { host, root } = makeHost();
  for (const el of elements.slice(0, 50)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const hl = div('hl');
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    root.append(hl);
  }
  setTimeout(() => host.remove(), ms);
}
