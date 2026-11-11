import { describe, expect, it } from 'vitest';
import { encodeDuration, parseBridgeCommand, parseBridgeMessage, skipTarget, volumeTarget, type BridgedMediaState } from './protocol';

const state: BridgedMediaState = {
  id: 1,
  isVideo: false,
  paused: false,
  ended: false,
  muted: false,
  volume: 1,
  loop: false,
  duration: 180,
  live: false,
  currentTime: 12.5,
  hasSource: true,
  area: 0,
};

describe('parseBridgeMessage', () => {
  it('round-trips a state message', () => {
    expect(parseBridgeMessage(JSON.stringify({ op: 'state', state }))).toEqual({ op: 'state', state });
  });

  it('accepts unknown duration', () => {
    const s = { ...state, duration: null };
    expect(parseBridgeMessage(JSON.stringify({ op: 'state', state: s }))).toEqual({ op: 'state', state: s });
  });

  it('parses gone messages', () => {
    expect(parseBridgeMessage(JSON.stringify({ op: 'gone', id: 3 }))).toEqual({ op: 'gone', id: 3 });
  });

  it.each([
    ['non-string detail', { op: 'gone', id: 1 }],
    ['invalid JSON', '{nope'],
    ['unknown op', JSON.stringify({ op: 'boom' })],
    ['bad id', JSON.stringify({ op: 'gone', id: 0 })],
    ['missing field', JSON.stringify({ op: 'state', state: { ...state, paused: undefined } })],
    ['wrong type', JSON.stringify({ op: 'state', state: { ...state, volume: '1' } })],
  ])('rejects %s', (_label, raw) => {
    expect(parseBridgeMessage(raw)).toBeNull();
  });
});

describe('parseBridgeCommand', () => {
  it('parses each command', () => {
    expect(parseBridgeCommand('{"id":1,"cmd":"play"}')).toEqual({ id: 1, cmd: 'play' });
    expect(parseBridgeCommand('{"id":1,"cmd":"pause"}')).toEqual({ id: 1, cmd: 'pause' });
    expect(parseBridgeCommand('{"id":1,"cmd":"seek","time":97}')).toEqual({ id: 1, cmd: 'seek', time: 97 });
    expect(parseBridgeCommand('{"id":1,"cmd":"mute","muted":true}')).toEqual({ id: 1, cmd: 'mute', muted: true });
    expect(parseBridgeCommand('{"id":1,"cmd":"skip","by":-10}')).toEqual({ id: 1, cmd: 'skip', by: -10 });
  });

  it('rejects malformed commands', () => {
    expect(parseBridgeCommand('{"id":1,"cmd":"seek","time":-5}')).toBeNull();
    expect(parseBridgeCommand('{"id":1,"cmd":"mute"}')).toBeNull();
    expect(parseBridgeCommand('{"id":1,"cmd":"skip","by":0}')).toBeNull();
    expect(parseBridgeCommand('{"id":1,"cmd":"skip"}')).toBeNull();
    expect(parseBridgeCommand('{"id":1,"cmd":"eval"}')).toBeNull();
    expect(parseBridgeCommand('{"cmd":"play"}')).toBeNull();
  });
});

describe('encodeDuration', () => {
  it('encodes live, unknown and finite durations', () => {
    expect(encodeDuration(Infinity)).toEqual({ duration: null, live: true });
    expect(encodeDuration(NaN)).toEqual({ duration: null, live: false });
    expect(encodeDuration(42)).toEqual({ duration: 42, live: false });
  });
});

describe('skipTarget', () => {
  it('skips within the media', () => {
    expect(skipTarget(50, 10, 180, null)).toBe(60);
    expect(skipTarget(50, -10, 180, null)).toBe(40);
    expect(skipTarget(4, -10, 180, null)).toBe(0);
    expect(skipTarget(175, 10, 180, null)).toBe(180);
  });

  it('skips within a live stream’s window, or not at all', () => {
    expect(skipTarget(1000, -10, Infinity, { start: 900, end: 1005 })).toBe(990);
    expect(skipTarget(905, -10, Infinity, { start: 900, end: 1005 })).toBe(900);
    expect(skipTarget(1000, 10, Infinity, { start: 900, end: 1005 })).toBe(1005);
    expect(skipTarget(1000, 10, Infinity, null)).toBeNull();
    expect(skipTarget(10, 10, NaN, null)).toBeNull();
  });
});

describe('volume', () => {
  it('steps on a grid of tenths, within 0–1', () => {
    expect(volumeTarget(0.5, 0.1)).toBe(0.6);
    expect(volumeTarget(0.5, -0.1)).toBe(0.4);
    expect(volumeTarget(0.73, 0.1)).toBe(0.8);
    expect(volumeTarget(0.73, -0.1)).toBe(0.7);
    expect(volumeTarget(1, 0.1)).toBe(1);
    expect(volumeTarget(0, -0.1)).toBe(0);
    expect(volumeTarget(0.30000000000000004, 0.1)).toBe(0.4);
    expect(volumeTarget(NaN, -0.1)).toBe(0.9);
  });

  it('carries a volume command to the page', () => {
    expect(parseBridgeCommand(JSON.stringify({ id: 1, cmd: 'volume', volume: 0.4 }))).toEqual({ id: 1, cmd: 'volume', volume: 0.4 });
    expect(parseBridgeCommand(JSON.stringify({ id: 1, cmd: 'volume', volume: 1.5 }))).toBeNull();
  });
});
