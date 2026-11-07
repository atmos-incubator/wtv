/**
 * Our UI in the top layer stacks in the order it was shown. When the overlay re-enters
 * the top layer (above a maximized video or fullscreen), other UI of ours that must stay
 * on top (the dev snapshot button) re-enters after it. Content script only.
 */
const listeners = new Set<() => void>();

export function onRestacked(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function notifyRestacked(): void {
  for (const cb of listeners) cb();
}
