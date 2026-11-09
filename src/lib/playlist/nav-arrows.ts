/**
 * Previous / next arrows over a playlist entry: the top frame of the entry's tab (content
 * script) and the card page. DOM only.
 *
 * Two tabs at the middle of the left and right edges, in the top layer above the page,
 * a maximized video and our overlay. They wake (dimly) for a few seconds whenever the
 * pointer moves, and show fully under it. Asleep they're invisible but still there, so
 * pointing at the edge shows one before it can be clicked. Pointer moves over our overlay
 * iframe reach us through its `pointer` / `activity` events (`poke`); ones over a
 * site's own iframes (an embedded player) don't, but the edges still answer to hovering.
 *
 * Previous only from the second entry on; Next on the last entry finishes the playlist
 * (or starts the next lap), like the popup's.
 */
import { WTV_UI_ATTR } from '../ads/probe';
import { onRestacked } from '../overlay/top-layer';

export type NavStep = 'previous' | 'next';

export interface NavArrows {
  /** Show Previous (not on the first entry). */
  update(canPrevious: boolean): void;
  /** The pointer moved (somewhere we can't see ourselves). */
  poke(): void;
  /** Out of the way (the selector picker is running). */
  suspend(on: boolean): void;
  remove(): void;
}

const AWAKE_MS = 2500;

const ARROW = (d: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const STYLE = `
  button {
    all: initial;
    position: fixed;
    top: 50%;
    translate: 0 -50%;
    width: 44px;
    height: 104px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    cursor: pointer;
    pointer-events: auto;
    color: #fff;
    background: rgb(0 0 0 / 0.35);
    opacity: 0;
    transition: opacity 0.25s, background-color 0.15s;
  }
  button[hidden], :host([data-suspended]) button { display: none; }
  .prev { left: 0; border-radius: 0 14px 14px 0; }
  .next { right: 0; border-radius: 14px 0 0 14px; }
  .awake button { opacity: 0.55; }
  button:hover, button:focus-visible { opacity: 1; background: rgb(0 0 0 / 0.6); }
  svg { width: 26px; height: 26px; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.6)); }
`;

export function createNavArrows(onStep: (step: NavStep) => void): NavArrows {
  const controller = new AbortController();
  const { signal } = controller;
  const host = document.createElement('div');
  host.setAttribute(WTV_UI_ATTR, '');
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0; padding: 0; border: 0; background: transparent; overflow: visible; pointer-events: none; z-index: 2147483647;';
  host.popover = 'manual';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const box = document.createElement('div');

  const make = (step: NavStep, label: string, path: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = step === 'previous' ? 'prev' : 'next';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = ARROW(path);
    // Keep the page from seeing these (players pause / open menus on clicks).
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      b.addEventListener(type, (e) => e.stopPropagation(), { signal });
    }
    b.addEventListener(
      'click',
      () => {
        b.blur();
        onStep(step);
      },
      { signal },
    );
    return b;
  };
  const prev = make('previous', 'Previous entry', 'M15 5l-7 7 7 7');
  const next = make('next', 'Next entry', 'M9 5l7 7-7 7');
  box.append(prev, next);
  root.append(style, box);

  let sleepTimer: ReturnType<typeof setTimeout> | undefined;

  /** Re-enter the top layer, above whatever entered it since. */
  function raise(): void {
    if (signal.aborted) return;
    if (!host.isConnected) (document.documentElement ?? document).append(host);
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Fixed + max z-index still covers most pages.
    }
  }

  function wake(): void {
    if (signal.aborted || host.hasAttribute('data-suspended')) return;
    if (!box.classList.contains('awake')) {
      raise();
      box.classList.add('awake');
    }
    if (sleepTimer !== undefined) clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => box.classList.remove('awake'), AWAKE_MS);
  }

  document.addEventListener('mousemove', wake, { capture: true, passive: true, signal });
  document.addEventListener('fullscreenchange', raise, { signal });
  const off = onRestacked(raise);
  signal.addEventListener('abort', off);
  raise();

  return {
    update(canPrevious) {
      prev.hidden = !canPrevious;
    },
    poke: wake,
    suspend(on) {
      host.toggleAttribute('data-suspended', on);
      if (!on) raise();
    },
    remove() {
      controller.abort();
      if (sleepTimer !== undefined) clearTimeout(sleepTimer);
      host.remove();
    },
  };
}
