/**
 * Content → background ad reporting over a long-lived port.
 *
 * A frame opens a port only while it has an ad. The port closing (ad over, frame
 * navigated or unloaded, content script invalidated) clears that frame's state
 * automatically, so a dead frame can never leave a tab muted.
 */

export const AD_PORT = 'wtv-ad';

export interface AdPortMessage {
  type: 'state';
  /** An ad is showing in this frame. */
  active: boolean;
  /** The user wants ads muted (Settings.muteAds). */
  mute: boolean;
}

export function parseAdPortMessage(raw: unknown): AdPortMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'state' || typeof m.active !== 'boolean' || typeof m.mute !== 'boolean') return null;
  return { type: 'state', active: m.active, mute: m.mute };
}
