import { describe, expect, it } from 'vitest';
import { IDLE, attributeMute, decideMute, type MutedInfo, type TabMuteState } from './mute';

const ME = 'wtv-extension-id';
const audible: MutedInfo = { muted: false };
const mutedByMe: MutedInfo = { muted: true, reason: 'extension', extensionId: ME };
const mutedByUser: MutedInfo = { muted: true, reason: 'user' };
const mutedByOther: MutedInfo = { muted: true, reason: 'extension', extensionId: 'someone-else' };
const owned: TabMuteState = { session: true, mutedByUs: true };
const notOwned: TabMuteState = { session: true, mutedByUs: false };

describe('decideMute', () => {
  it('mutes an audible tab when an ad starts', () => {
    expect(decideMute(IDLE, true, audible, ME)).toEqual({ action: 'mute', state: owned });
  });

  it('leaves a tab the user already muted', () => {
    expect(decideMute(IDLE, true, mutedByUser, ME)).toEqual({ action: 'none', state: notOwned });
  });

  it('leaves a tab another extension muted', () => {
    expect(decideMute(IDLE, true, mutedByOther, ME)).toEqual({ action: 'none', state: notOwned });
  });

  it('reclaims its own mute when state was lost (service worker restart)', () => {
    expect(decideMute(IDLE, true, mutedByMe, ME)).toEqual({ action: 'none', state: owned });
  });

  it('does nothing while the ad continues', () => {
    expect(decideMute(owned, true, mutedByMe, ME)).toEqual({ action: 'none', state: owned });
  });

  it('gives up ownership when the user unmutes during the ad, and does not re-mute', () => {
    const d = decideMute(owned, true, audible, ME);
    expect(d).toEqual({ action: 'none', state: notOwned });
    expect(decideMute(d.state, true, audible, ME).action).toBe('none');
  });

  it('gives up ownership when the user re-mutes during the ad', () => {
    expect(decideMute(owned, true, mutedByUser, ME).state.mutedByUs).toBe(false);
  });

  it('unmutes when the ad ends and the mute is still ours', () => {
    expect(decideMute(owned, false, mutedByMe, ME)).toEqual({ action: 'unmute', state: IDLE });
  });

  it('does not unmute when the user took over', () => {
    expect(decideMute(notOwned, false, mutedByUser, ME)).toEqual({ action: 'none', state: IDLE });
    expect(decideMute(owned, false, mutedByUser, ME)).toEqual({ action: 'none', state: IDLE });
  });

  it('does nothing when idle', () => {
    expect(decideMute(IDLE, false, audible, ME)).toEqual({ action: 'none', state: IDLE });
    expect(decideMute(IDLE, false, mutedByMe, ME)).toEqual({ action: 'none', state: IDLE });
  });
});

describe('attributeMute', () => {
  it('treats our mute as the user\'s when they muted with the Wtv command', () => {
    const info = attributeMute(mutedByMe, true, ME);
    expect(info).toEqual(mutedByUser);
    // So an ad ending afterwards leaves it muted...
    expect(decideMute(IDLE, false, info, ME).action).toBe('none');
    // ...and an ad starting doesn't claim it.
    expect(decideMute(IDLE, true, info, ME).state).toEqual(notOwned);
  });

  it('leaves other mutes alone', () => {
    expect(attributeMute(mutedByMe, false, ME)).toBe(mutedByMe);
    expect(attributeMute(audible, true, ME)).toBe(audible);
    expect(attributeMute(mutedByOther, true, ME)).toBe(mutedByOther);
  });
});
