import { describe, expect, it } from 'vitest';
import { encodeDuration, parseBridgeCommand, parseBridgeMessage, type BridgedMediaState } from './protocol';

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
  });

  it('rejects malformed commands', () => {
    expect(parseBridgeCommand('{"id":1,"cmd":"seek","time":-5}')).toBeNull();
    expect(parseBridgeCommand('{"id":1,"cmd":"mute"}')).toBeNull();
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
