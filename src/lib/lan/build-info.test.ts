import { describe, expect, it } from 'vitest';
import { newBuildId, parseBuildInfo, shouldReload } from './build-info';

const info = (id: string) => ({ id, version: '2.0.0', builtAt: '2026-11-09T14:22:33.000Z' });

describe('parseBuildInfo', () => {
  it('reads a build file', () => {
    expect(parseBuildInfo(info('2.0.0+20261109-142233-a1b2'))).toEqual(info('2.0.0+20261109-142233-a1b2'));
  });

  it('ignores junk', () => {
    expect(parseBuildInfo(null)).toBeNull();
    expect(parseBuildInfo([])).toBeNull();
    expect(parseBuildInfo({ ...info('x'), id: '' })).toBeNull();
    expect(parseBuildInfo({ ...info('x'), id: 'a b' })).toBeNull();
    expect(parseBuildInfo({ ...info('x'), id: '../x' })).toBeNull();
    expect(parseBuildInfo({ id: 'x', version: 2, builtAt: '' })).toBeNull();
  });
});

describe('newBuildId', () => {
  it('is the version, the time and a short random tail', () => {
    expect(newBuildId('2.0.0', new Date(2026, 10, 9, 14, 2, 3), 0.5)).toBe('2.0.0+20261109-140203-8000');
    expect(parseBuildInfo(info(newBuildId('2.0.0', new Date(), 0.999)))).not.toBeNull();
  });
});

describe('shouldReload', () => {
  it('reloads for another build on disk', () => {
    expect(shouldReload('a', info('b'), null)).toBe(true);
  });

  it('not for the same build, or none', () => {
    expect(shouldReload('a', info('a'), null)).toBe(false);
    expect(shouldReload('a', null, null)).toBe(false);
  });

  it('not again when a reload for that build left the same one running', () => {
    expect(shouldReload('a', info('b'), { running: 'a', disk: 'b' })).toBe(false);
    expect(shouldReload('a', info('c'), { running: 'a', disk: 'b' })).toBe(true);
    expect(shouldReload('c', info('b'), { running: 'a', disk: 'b' })).toBe(true);
  });
});
