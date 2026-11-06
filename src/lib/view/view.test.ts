import { describe, expect, it } from 'vitest';
import { electFrame, type FrameReport } from './elect';
import {
  VIEW_APPLY,
  VIEW_COMMAND,
  VIEW_READY,
  VIEW_STATE,
  VIEW_VERIFY,
  isViewToken,
  newViewToken,
  parseFrameCandidate,
  parseViewApply,
  parseViewRequest,
  type FrameCandidate,
} from './messages';

const none: FrameCandidate = { maximized: null, video: null, media: null };
const frame = (frameId: number, c: Partial<FrameCandidate>): FrameReport => ({ frameId, candidate: { ...none, ...c } });
const video = (area: number, playing: boolean): Partial<FrameCandidate> => ({ video: { area, playing }, media: { playing } });

describe('electFrame: maximize', () => {
  it('needs a video on screen', () => {
    expect(electFrame([frame(0, { media: { playing: true } })], 'maximize')).toBeNull();
    expect(electFrame([], 'maximize')).toBeNull();
  });

  it('prefers playing, then bigger, then the top frame', () => {
    expect(electFrame([frame(0, video(900, false)), frame(3, video(100, true))], 'maximize')).toBe(3);
    expect(electFrame([frame(0, video(100, true)), frame(3, video(900, true))], 'maximize')).toBe(3);
    expect(electFrame([frame(5, video(500, true)), frame(0, video(500, true))], 'maximize')).toBe(0);
  });
});

describe('electFrame: playback', () => {
  it('targets the maximized video first', () => {
    const frames = [frame(0, video(900, true)), frame(2, { ...video(400, false), maximized: 'media' })];
    expect(electFrame(frames, 'playback')).toBe(2);
  });

  it('ignores frames that only maximized an iframe', () => {
    const frames = [frame(0, { maximized: 'frame' }), frame(2, { ...video(400, true), maximized: 'media' })];
    expect(electFrame(frames, 'playback')).toBe(2);
  });

  it('then whatever is playing, including audio-only', () => {
    const frames = [frame(0, video(900, false)), frame(4, { media: { playing: true } })];
    expect(electFrame(frames, 'playback')).toBe(4);
  });
});

describe('view messages', () => {
  it('parses requests from the popup and content scripts', () => {
    expect(parseViewRequest({ type: VIEW_COMMAND, op: 'toggle-tv', tabId: 7 })).toEqual({
      type: VIEW_COMMAND,
      op: 'toggle-tv',
      tabId: 7,
    });
    expect(parseViewRequest({ type: VIEW_COMMAND, op: 'mute' })).toEqual({ type: VIEW_COMMAND, op: 'mute', tabId: null });
    expect(parseViewRequest({ type: VIEW_COMMAND, op: 'explode' })).toBeNull();
    expect(parseViewRequest({ type: VIEW_STATE, tabId: -1 })).toEqual({ type: VIEW_STATE, tabId: null });
    expect(parseViewRequest({ type: VIEW_READY })).toEqual({ type: VIEW_READY });
    expect(parseViewRequest({ type: 'wtv/other' })).toBeNull();
  });

  it('only accepts well-formed tokens', () => {
    const token = newViewToken();
    expect(isViewToken(token)).toBe(true);
    expect(parseViewRequest({ type: VIEW_VERIFY, token })).toEqual({ type: VIEW_VERIFY, token });
    expect(parseViewRequest({ type: VIEW_VERIFY, token: 'abc' })).toBeNull();
    expect(parseViewApply({ type: VIEW_APPLY, op: 'maximize', token })).toEqual({ type: VIEW_APPLY, op: 'maximize', token });
    expect(parseViewApply({ type: VIEW_APPLY, op: 'maximize' })).toBeNull();
    expect(parseViewApply({ type: VIEW_APPLY, op: 'restore' })).toEqual({ type: VIEW_APPLY, op: 'restore' });
    expect(parseViewApply({ type: VIEW_APPLY, op: 'nope' })).toBeNull();
  });

  it('parses frame candidates defensively', () => {
    expect(parseFrameCandidate(null)).toBeNull();
    expect(parseFrameCandidate({})).toEqual(none);
    expect(
      parseFrameCandidate({ maximized: 'media', video: { area: 10, playing: true }, media: { playing: true } }),
    ).toEqual({ maximized: 'media', video: { area: 10, playing: true }, media: { playing: true } });
    expect(parseFrameCandidate({ maximized: 'yes', video: { area: -1, playing: true } })).toEqual(none);
  });
});
