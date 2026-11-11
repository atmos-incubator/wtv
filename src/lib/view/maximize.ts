/**
 * Maximize an element (a <video>, or the <iframe> holding a child frame's video) by
 * putting it in the top layer. DOM-only (content script).
 *
 * Why the top layer and not z-index: z-index can't escape ancestor stacking contexts
 * (transform, filter, contain, will-change) or overflow clipping, and re-parenting a
 * <video> pauses it and breaks site players. A `popover="manual"` element shown with
 * showPopover() renders above everything regardless of where it sits in the DOM, and
 * its ::backdrop is the letterbox.
 *
 * Styles are injected with !important (sites set inline sizes) on an attribute selector
 * padded with :not(#a#b) for ID-level specificity, so ordinary page rules can't win.
 * Elements inside open shadow roots get the stylesheet in their own root.
 *
 * `placeMaximized` puts it in a box instead of filling the tab (a post's embedded player
 * over its card: posts/embed.ts); its backdrop is then see-through.
 */

export const MAX_ATTR = 'data-wtv-maximized';
/** On <html> while something in this document is maximized: stops the page scrolling. */
const ACTIVE_ATTR = 'data-wtv-maximize-active';
const STYLE_ATTR = 'data-wtv-maximize-style';
const SEL = `[${MAX_ATTR}]:not(#wtv-x#wtv-y)`;

const CSS = `
${SEL} {
  position: fixed !important;
  inset: auto !important;
  left: var(--wtv-max-left, 0px) !important;
  top: var(--wtv-max-top, 0px) !important;
  width: var(--wtv-max-width, 100%) !important;
  height: var(--wtv-max-height, 100%) !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: none !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  box-sizing: border-box !important;
  transform: none !important;
  translate: none !important;
  scale: none !important;
  rotate: none !important;
  clip-path: none !important;
  mask: none !important;
  filter: none !important;
  opacity: 1 !important;
  visibility: visible !important;
  display: block !important;
  overflow: hidden !important;
  object-fit: contain !important;
  object-position: center !important;
  background: #000 !important;
}
${SEL}::backdrop {
  background: #000 !important;
}
${SEL}[${MAX_ATTR}='box']::backdrop {
  background: transparent !important;
}
html[${ACTIVE_ATTR}] {
  overflow: hidden !important;
}
`;

const BOX_PROPS = ['--wtv-max-left', '--wtv-max-top', '--wtv-max-width', '--wtv-max-height'] as const;

/** A maximized element: fill `box` (viewport px) instead of the tab; null fills the tab again. */
export function placeMaximized(
  el: HTMLElement,
  box: { left: number; top: number; width: number; height: number } | null,
): void {
  if (!el.hasAttribute(MAX_ATTR)) return;
  if (!box) {
    for (const p of BOX_PROPS) el.style.removeProperty(p);
    el.setAttribute(MAX_ATTR, '');
    return;
  }
  const values = [box.left, box.top, box.width, box.height];
  BOX_PROPS.forEach((p, i) => el.style.setProperty(p, `${Math.round(values[i]!)}px`, 'important'));
  el.setAttribute(MAX_ATTR, 'box');
}

function ensureStyle(root: Document | ShadowRoot): void {
  const container = root instanceof Document ? (root.head ?? root.documentElement) : root;
  if (!container) return;
  // Checked in the DOM, not remembered: a reloaded content script must not add another.
  if (!container.querySelector(`style[${STYLE_ATTR}]`)) {
    const style = document.createElement('style');
    style.setAttribute(STYLE_ATTR, '');
    style.textContent = CSS;
    container.append(style);
  }
  // The <html> rule must live in the document even when the element is in a shadow root.
  if (!(root instanceof Document)) ensureStyle(document);
}

/**
 * Put a maximized element back in the top layer if it fell out; true when it did.
 *
 * A page that moves its player in the DOM (YouTube does, re-laying out after a resize and
 * between videos) takes it out of the top layer without a `toggle` event: removing an
 * element hides its popover silently. It keeps our fixed, full-size styles, so it looks
 * maximized, but now sits under whatever the page draws next.
 */
export function reassertMaximized(el: HTMLElement): boolean {
  if (!el.hasAttribute(MAX_ATTR) || !el.isConnected || el.matches(':popover-open')) return false;
  const root = el.getRootNode();
  // It may have moved into another shadow root.
  if (root instanceof Document || root instanceof ShadowRoot) ensureStyle(root);
  if (!el.hasAttribute('popover')) el.popover = 'manual';
  try {
    el.showPopover();
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a release function, or null if the element can't be shown in the top layer.
 * `onClosed` fires if something other than release() closes it (e.g. the page's own
 * popover handling).
 */
export function maximizeElement(el: HTMLElement, onClosed: () => void): (() => void) | null {
  const root = el.getRootNode();
  if (!el.isConnected || !(root instanceof Document || root instanceof ShadowRoot)) return null;
  ensureStyle(root);

  const previousPopover = el.getAttribute('popover');
  let released = false;

  const onToggle = (e: Event) => {
    if (!released && (e as ToggleEvent).newState === 'closed') {
      release();
      onClosed();
    }
  };

  function release(): void {
    if (released) return;
    released = true;
    el.removeEventListener('toggle', onToggle);
    try {
      if (el.matches(':popover-open')) el.hidePopover();
    } catch {
      // Already gone.
    }
    // A [popover] that isn't open is display:none, so put back exactly what was there.
    if (previousPopover === null) el.removeAttribute('popover');
    else el.setAttribute('popover', previousPopover);
    el.removeAttribute(MAX_ATTR);
    for (const p of BOX_PROPS) el.style.removeProperty(p);
    document.documentElement.removeAttribute(ACTIVE_ATTR);
  }

  el.setAttribute(MAX_ATTR, '');
  if (previousPopover === null) el.popover = 'manual';
  try {
    if (!el.matches(':popover-open')) el.showPopover();
  } catch {
    release();
    return null;
  }
  el.addEventListener('toggle', onToggle);
  document.documentElement.setAttribute(ACTIVE_ATTR, '');
  return release;
}
