import { describe, expect, it } from 'vitest';
import { parseAdPortMessage } from './protocol';

describe('parseAdPortMessage', () => {
  it('accepts a valid state message', () => {
    expect(parseAdPortMessage({ type: 'state', active: true, mute: false })).toEqual({
      type: 'state',
      active: true,
      mute: false,
    });
  });

  it.each([null, 'state', { type: 'state', active: 'yes', mute: true }, { type: 'other', active: true, mute: true }])(
    'rejects %j',
    (raw) => {
      expect(parseAdPortMessage(raw)).toBeNull();
    },
  );
});
