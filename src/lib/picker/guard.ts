/**
 * The picker's event guard: window capture listeners for the events a pick is made of,
 * added at document_start, before any of the page's own scripts run.
 *
 * Listeners on the same target run in the order they were added, isolated world and
 * page alike. The picker only starts long after the page has added its own window
 * capture listeners, so listeners it added then would run after the page's: a page that
 * acts on pointerdown at the window (Reddit opens its media viewer that way) would act
 * before the picker could stop it, and could swallow the click the pick waits for. Added
 * first, these run first, and stopImmediatePropagation() keeps every page listener out.
 *
 * Idle (one null check per event) unless a picker has set a handler.
 */

/** What a pick is made of; the page sees none of them while picking. */
export const GUARDED_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'touchstart',
  'touchend',
  'dragstart',
  'selectstart',
] as const;

type Handler = (e: Event) => void;

let handler: Handler | null = null;
let installed = false;

/** Content script, at document_start. */
export function installPickGuard(signal: AbortSignal): void {
  if (installed) return;
  installed = true;
  const listener = (e: Event) => handler?.(e);
  for (const type of GUARDED_EVENTS) window.addEventListener(type, listener, { capture: true, signal });
  signal.addEventListener('abort', () => {
    installed = false;
    handler = null;
  });
}

/**
 * Route guarded events to `h` (null: back to idle). Returns false when the guard isn't
 * installed (a script injected into an already-open page): the caller listens itself.
 */
export function setPickGuard(h: Handler | null): boolean {
  if (!installed) return false;
  handler = h;
  return true;
}
