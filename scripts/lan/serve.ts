/**
 * Serve the LAN build to another computer on the network (dev only; never shipped).
 *
 *   npm run lan:build    build it (again, whenever you like: this picks up each new build)
 *   npm run lan:serve    serve it until Ctrl+C
 *
 * The other computer keeps an unpacked copy in step with scripts/lan/wtv-sync.ps1 (open this
 * server's address in a browser there for the one-line setup). Only the build is served,
 * read-only: no playlists or settings cross the network.
 *
 *   GET /               setup instructions, with this server's address filled in
 *   GET /build.json     the current build's id (503 while a build is being written)
 *   GET /wtv.zip        the build folder, zipped (once per build)
 *   GET /wtv-sync.ps1   the Windows sync script
 *
 *   --port <n>   default 8788
 *   --dir <path> default .output/chrome-mv3-lan
 */
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUILD_FILE, parseBuildInfo, type BuildInfo } from '../../src/lib/lan/build-info.ts';
import { readTree, zip } from './zip.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SYNC_SCRIPT = fileURLToPath(new URL('./wtv-sync.ps1', import.meta.url));

const { values: args } = parseArgs({
  options: { port: { type: 'string', default: '8788' }, dir: { type: 'string', default: '.output/chrome-mv3-lan' } },
});
const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port: ${args.port}`);
const dir = resolve(ROOT, args.dir);

/** The build in the folder, or null while there's none (or one is being written). */
function current(): BuildInfo | null {
  try {
    return parseBuildInfo(JSON.parse(readFileSync(resolve(dir, BUILD_FILE), 'utf8')));
  } catch {
    return null;
  }
}

let cached: { info: BuildInfo; zip: Buffer } | null = null;

/** The build zipped, or null when it changed while zipping (a build finished meanwhile). */
function zipped(): { info: BuildInfo; zip: Buffer } | null {
  const info = current();
  if (!info) return null;
  if (cached?.info.id === info.id) return cached;
  let data: Buffer;
  try {
    data = zip(readTree(dir));
  } catch {
    return null;
  }
  if (current()?.id !== info.id) return null;
  cached = { info, zip: data };
  console.info(`zipped ${info.id} (${(data.length / 1e6).toFixed(1)} MB)`);
  return cached;
}

function addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, head: boolean): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(head ? undefined : body);
}

function instructions(server: string): string {
  const info = current();
  return `Wtv LAN build: ${info ? `${info.id} (built ${info.builtAt})` : 'none yet (npm run lan:build)'}

On the Windows computer, in PowerShell:

  iwr ${server}/wtv-sync.ps1 -OutFile $env:TEMP\\wtv-sync.ps1 -UseBasicParsing; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\\wtv-sync.ps1 -Server ${server} -Install

That copies the build to %LOCALAPPDATA%\\Wtv\\extension and checks for new ones every minute
from then on (from each sign-in too). Then, once, in Chrome:

  chrome://extensions > Developer mode on > Load unpacked > %LOCALAPPDATA%\\Wtv\\extension

New builds reload Wtv by themselves once no playlist is playing and no Wtv page is open.
Never Remove the extension: that deletes its playlists. Reload is fine.
To stop syncing: powershell -ExecutionPolicy Bypass -File %LOCALAPPDATA%\\Wtv\\wtv-sync.ps1 -Uninstall
`;
}

const server = createServer((req, res) => {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) return send(res, 405, 'text/plain', 'GET only\n', false);
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const host = /^[\w.:[\]-]+$/.test(req.headers.host ?? '') ? req.headers.host! : `localhost:${port}`;
  switch (path) {
    case '/':
      return send(res, 200, 'text/plain; charset=utf-8', instructions(`http://${host}`), head);
    case `/${BUILD_FILE}`: {
      const info = current();
      return info
        ? send(res, 200, 'application/json', JSON.stringify(info), head)
        : send(res, 503, 'text/plain', 'no build yet, or one is being written\n', head);
    }
    case '/wtv.zip': {
      const z = zipped();
      if (!z) return send(res, 503, 'text/plain', 'no build yet, or one is being written\n', head);
      if (!head) console.info(`${req.socket.remoteAddress} downloaded ${z.info.id}`);
      return send(res, 200, 'application/zip', z.zip, head);
    }
    case '/wtv-sync.ps1':
      return send(res, 200, 'text/plain; charset=utf-8', readFileSync(SYNC_SCRIPT), head);
    default:
      return send(res, 404, 'text/plain', 'not found\n', head);
  }
});

server.listen(port, '0.0.0.0', () => {
  const info = current();
  console.info(`Serving ${dir}`);
  console.info(info ? `Build ${info.id}` : 'No LAN build yet: run npm run lan:build (this picks it up).');
  for (const a of addresses()) console.info(`  http://${a}:${port}/`);
  console.info('Open one of those on the other computer for the setup steps.');
});
