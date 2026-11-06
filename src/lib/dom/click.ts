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
