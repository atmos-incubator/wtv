/**
 * Click an element the way a mouse would: pointer + mouse down / up at its centre, then
 * click. Some players listen for pointerdown / mouseup rather than click, and ignore a
 * bare element.click(). DOM-only (content script).
 *
 * Still `isTrusted: false`. Sites that check it can't be clicked from a content script
 * at all (only chrome.debugger can, and that shows a warning bar), so callers need a
 * fallback.
 */
export function simulateClick(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const clientX = r.left + r.width / 2;
  const clientY = r.top + r.height / 2;
  const mouse: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: window.screenX + clientX,
    screenY: window.screenY + clientY,
    button: 0,
  };
  const pointer: PointerEventInit = { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true };

  el.dispatchEvent(new PointerEvent('pointerover', pointer));
  el.dispatchEvent(new MouseEvent('mouseover', mouse));
  el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...mouse, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...mouse, buttons: 0 }));
}

/**
 * Ways to activate a button without a real user, tried in order across retries. All are
 * `isTrusted: false`; which one a site responds to (if any) varies:
 *   - pointer:  simulateClick() on the element.
 *   - inner:    simulateClick() on whatever is hit-tested at its centre (our overlay
 *               excluded), when that's inside it: some sites listen on the label, not the
 *               button, and events don't travel down.
 *   - click:    HTMLElement.click(), which also runs the element's activation behaviour.
 *   - keyboard: focus it, then Enter and Space key events.
 */
export const CLICK_STRATEGIES = ['pointer', 'inner', 'click', 'keyboard'] as const;
export type ClickStrategy = (typeof CLICK_STRATEGIES)[number];

export function activate(el: HTMLElement, strategy: ClickStrategy, isOurs: (el: Element) => boolean): void {
  switch (strategy) {
    case 'pointer':
      simulateClick(el);
      break;
    case 'inner': {
      const r = el.getBoundingClientRect();
      const hit = document
        .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        .find((e) => !isOurs(e));
      simulateClick(hit instanceof HTMLElement && el.contains(hit) ? hit : el);
      break;
    }
    case 'click':
      el.click();
      break;
    case 'keyboard':
      el.focus({ preventScroll: true });
      for (const [key, code] of [
        ['Enter', 'Enter'],
        [' ', 'Space'],
      ] as const) {
        const init: KeyboardEventInit = { key, code, bubbles: true, cancelable: true, composed: true };
        el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
      }
      break;
  }
}
