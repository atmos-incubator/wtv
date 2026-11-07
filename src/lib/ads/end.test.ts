import { describe, expect, it } from 'vitest';
import { AD_END_GRACE_MS, AD_END_MAX_MS, adEndDecision } from './end';

describe('adEndDecision', () => {
  it('waits out the grace period even if the show plays', () => {
    expect(adEndDecision(AD_END_GRACE_MS - 1, true)).toBe('wait');
  });
  it('ends once the show is playing after the grace', () => {
    expect(adEndDecision(AD_END_GRACE_MS, true)).toBe('end');
  });
  it('keeps waiting while nothing plays (the next ad of a pod loading)', () => {
    expect(adEndDecision(AD_END_GRACE_MS + 2000, false)).toBe('wait');
  });
  it('gives up waiting after the maximum', () => {
    expect(adEndDecision(AD_END_MAX_MS, false)).toBe('end');
  });
});
