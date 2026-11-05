/**
 * Run `fn` once, `delay` ms after the first call; calls while pending are absorbed.
 * Unlike a trailing debounce, this still fires under a constant stream of calls
 * (e.g. a page mutating the DOM every frame), at most once per `delay`.
 */
export function scheduler(fn: () => void, delay: number, signal: AbortSignal): () => void {
  let pending = false;
  return () => {
    if (pending || signal.aborted) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!signal.aborted) fn();
    }, delay);
  };
}
