/**
 * When is an ad over? Pure.
 *
 * The ad indicator going away isn't enough: between the ads of a pod, or while the player
 * loads the show after the last ad, the indicator can drop for a moment and come back.
 * Ending the ad there flashes the page (pictures off, sound on) between two ads. So the
 * ad ends once the indicator has been gone for the grace period AND the show is actually
 * playing (its time moving), or after AD_END_MAX_MS whatever the player is doing (the
 * user may have paused, or the site may never resume on its own).
 */
export const AD_END_GRACE_MS = 1500;
export const AD_END_MAX_MS = 8000;
export const AD_END_POLL_MS = 250;

export function adEndDecision(goneForMs: number, showProgressing: boolean): 'end' | 'wait' {
  if (goneForMs < AD_END_GRACE_MS) return 'wait';
  if (showProgressing || goneForMs >= AD_END_MAX_MS) return 'end';
  return 'wait';
}
