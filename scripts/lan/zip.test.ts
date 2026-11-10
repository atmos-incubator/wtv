import { describe, expect, it } from 'vitest';
import { crc32, inflateRawSync } from 'node:zlib';
import { zip } from './zip';

/** Read a zip back through its central directory, checking the local headers agree. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  expect(at + buf.readUInt32LE(end + 12)).toBe(end);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    expect(buf.toString('utf8', local + 30, local + 30 + buf.readUInt16LE(local + 26))).toBe(name);
    const start = local + 30 + nameLen + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : body;
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString('utf8');
    at += 46 + nameLen;
  }
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('zip', () => {
  it('round-trips files, deflated or stored', () => {
    const files = {
      'manifest.json': '{"name":"Wtv"}',
      'assets/big.js': 'console.log("wtv");\n'.repeat(500),
      'pictures/é.txt': 'x',
      'empty.txt': '',
    };
    const buf = zip(Object.entries(files).map(([path, s]) => ({ path, data: enc(s) })));
    expect(unzip(buf)).toEqual(files);
  });

  it('writes an empty zip', () => {
    expect(unzip(zip([]))).toEqual({});
  });

  it('refuses paths that would land outside the folder', () => {
    for (const path of ['/etc/x', '../x', 'a/../../x', 'a\\b', '', 'a//b', './a']) {
      expect(() => zip([{ path, data: enc('x') }])).toThrow(/bad path/);
    }
  });
});
