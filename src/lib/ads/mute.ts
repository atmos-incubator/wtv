/**
 * Tab mute ownership. Pure.
 *
 * Rules:
 *   - When an ad starts and the tab is audible, mute it and remember we did.
 *   - When an ad starts and the tab is already muted, leave it. If that mute is ours
 *     (e.g. state recovered after a service-worker restart) we still own it.
 *   - If the user unmutes during an ad, or re-mutes it themselves, we give up ownership
 *     and won't touch the tab again until the next ad.
 *   - When the ad ends, unmute only if the tab is still muted by *this* extension.
 */

export interface MutedInfo {
  muted: boolean;
  reason?: string;
  extensionId?: string;
}

export interface TabMuteState {
  /** An ad wanting mute is in progress for this tab. */
  session: boolean;
  /** We muted the tab and still own that mute. */
  mutedByUs: boolean;
}

export const IDLE: Readonly<TabMuteState> = Object.freeze({ session: false, mutedByUs: false });

export type MuteAction = 'mute' | 'unmute' | 'none';

export interface MuteDecision {
  action: MuteAction;
  state: TabMuteState;
}

export function isOurMute(info: MutedInfo, extensionId: string): boolean {
  return info.muted && info.reason === 'extension' && info.extensionId === extensionId;
}

export function decideMute(
  prev: TabMuteState,
  wantMute: boolean,
  info: MutedInfo,
  extensionId: string,
): MuteDecision {
  const ours = isOurMute(info, extensionId);

  if (wantMute) {
    if (!prev.session) {
      if (!info.muted) return { action: 'mute', state: { session: true, mutedByUs: true } };
      return { action: 'none', state: { session: true, mutedByUs: ours } };
    }
    // Mid-ad: keep ownership only while the tab is still muted by us.
    return { action: 'none', state: { session: true, mutedByUs: prev.mutedByUs && ours } };
  }

  if (prev.mutedByUs && ours) return { action: 'unmute', state: { ...IDLE } };
  return { action: 'none', state: { ...IDLE } };
}
