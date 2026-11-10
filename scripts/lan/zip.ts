/**
 * A minimal zip writer (dev only; never shipped): enough for Windows' Expand-Archive to unpack
 * a build folder. Deflate per file (stored when that's no smaller), UTF-8 names, no zip64.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Forward slashes, relative, e.g. `assets/popup.js`. */
  path: string;
  data: Uint8Array;
}

/** 2020-01-01 00:00 in DOS form: the build id says when; the files don't need to. */
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8 = 0x0800;

function checkPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`zip: bad path ${JSON.stringify(path)}`);
  }
}

export function zip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('zip: too many files');
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    checkPath(e.path);
    const name = Buffer.from(e.path, 'utf8');
    const data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(UTF8, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
    if (offset > 0xffffffff) throw new Error('zip: too big');
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Every file under `root`, with paths relative to it, sorted. */
export function readTree(root: string): ZipEntry[] {
  const out: ZipEntry[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path);
      else if (d.isFile()) out.push({ path, data: readFileSync(join(root, path)) });
    }
  };
  walk('');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
