/**
 * Dev-only: outline the primary media element with a label. Pointer-events none, so it
 * never interferes with the page. Only created when DEV_TOOLS is on.
 */

export interface DebugOverlay {
  show(rect: DOMRect | null, label: string): void;
  destroy(): void;
}

export function createDebugOverlay(): DebugOverlay {
  let box: HTMLDivElement | null = null;
  let tag: HTMLDivElement | null = null;

  function ensure(): void {
    if (box || !document.documentElement) return;
    box = document.createElement('div');
    box.style.cssText = [
      'all: initial',
      'position: fixed',
      'pointer-events: none',
      'z-index: 2147483647',
      'box-sizing: border-box',
      'border: 3px dashed #ff2bd6',
      'display: none',
    ].join(';');
    tag = document.createElement('div');
    tag.style.cssText = [
      'all: initial',
      'position: absolute',
      'top: 0',
      'left: 0',
      'padding: 2px 6px',
      'background: #ff2bd6',
      'color: #fff',
      'font: 600 11px/1.4 system-ui, sans-serif',
      'white-space: nowrap',
    ].join(';');
    box.append(tag);
    document.documentElement.append(box);
  }

  return {
    show(rect, label) {
      ensure();
      if (!box || !tag) return;
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      tag.textContent = label;
    },
    destroy() {
      box?.remove();
      box = null;
      tag = null;
    },
  };
}
