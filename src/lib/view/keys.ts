/** Keys Wtv answers over the show. Pure. */

/** ← / → with no modifier (Shift aside): skip back / forward. */
export function skipKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): 'back' | 'forward' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return e.key === 'ArrowLeft' ? 'back' : e.key === 'ArrowRight' ? 'forward' : null;
}
