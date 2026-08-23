#!/usr/bin/env node
/* The local dev server behind `make dev`.

   yootri has no build step, so "running it locally" only ever means putting a
   real HTTP origin in front of this folder — ES modules will not load from a
   `file://` page, and neither will the relative asset paths. `python3 -m
   http.server` does that much, and the README has said so for a while. This
   exists because three things it does not do all cost real debugging time:

   - **Content-Type.** A `.js` file served as anything but JavaScript is refused
     by the browser's module loader, and the page comes up with no engine behind
     it at all.
   - **Caching.** index.html is one 180 KB file that gets edited constantly.
     Conditional requests are correct and still leave you looking at a page that
     does not match the file you just saved.
   - **404s.** A missing asset must 404, exactly as it will on Pages. A server
     that falls back to index.html turns a case-wrong path — the specific bug
     tests/index-html.test.js exists to catch — into a page that loads fine on
     macOS and breaks in production.

   It is also why sign-in works: the banner prints `http://localhost:$PORT`, and
   `localhost` is on Firebase's authorized-domain list by default. `127.0.0.1`
   is not, so a URL spelled that way fails Google sign-in and nothing else.

   No dependencies; Node is already required for `npm test`.

       node tools/dev-server.mjs [port]        PORT=8001 make dev  */

import { createServer } from 'node:http';
import { createReadStream, statSync, realpathSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

/* Everything a browser asks this repo for. Anything else is a download, and
   application/octet-stream is the honest answer for it. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const asPath = (p) => (p instanceof URL || String(p).startsWith('file:') ? fileURLToPath(p) : String(p));

/* macOS and Windows will happily open `Season.js` when the file on disk is
   `season.js`. Pages, on Linux, will not — so that typo survives review, gets
   merged, and breaks in production, which is the most expensive place to find
   it. realpath.native reports the name as it is actually stored, so a request
   whose spelling does not match is a 404 here too.

   It resolves symlinks as well, so a symlinked path inside the repo would 404.
   yootri has none, and a dev server is the right place to make that trade. */
function sameOnDisk(file) {
  try {
    return realpathSync.native(file) === file;
  } catch {
    return false;
  }
}

/** `{ file, size }` for what `url` names, or `{ error }` with the status to send. */
function resolveFile(root, url) {
  const raw = url.split('?')[0].split('#')[0];

  let pathname;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    return { error: 400 };                       // malformed percent-escape
  }
  if (pathname.includes('\0')) return { error: 400 };

  /* join() normalizes, so `/../package.json` becomes a path outside root rather
     than staying a literal `..` — which is why the containment check below has
     to happen on the resolved path and not on the string that arrived. */
  const full = resolve(join(root, pathname));
  if (full !== root && !full.startsWith(root + sep)) return { error: 403 };

  let stat;
  try {
    stat = statSync(full);
  } catch {
    return { error: 404 };
  }

  /* A directory serves its own index.html and nothing else — no listing, which
     would publish the repo's shape, and no fallback to the app, which would
     turn a typo'd asset path into a page that loads. */
  if (stat.isDirectory()) {
    const index = join(full, 'index.html');
    try {
      const inner = statSync(index);
      if (inner.isFile()) return sameOnDisk(index) ? { file: index, size: inner.size } : { error: 404 };
    } catch { /* falls through to 404 */ }
    return { error: 404 };
  }

  return sameOnDisk(full) ? { file: full, size: stat.size } : { error: 404 };
}

/** A static server rooted at `root`, not yet listening. */
export function createDevServer({ root }) {
  const base = realpathSync.native(asPath(root)).replace(new RegExp(`\\${sep}$`), '');

  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      return res.end('Method Not Allowed\n');
    }

    const found = resolveFile(base, req.url || '/');
    if (found.error) {
      const body = `${found.error}\n`;
      res.writeHead(found.error, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    res.writeHead(200, {
      'content-type': TYPES[extname(found.file).toLowerCase()] || 'application/octet-stream',
      'content-length': found.size,
      // The whole point of a dev server: what you saved is what you get.
      'cache-control': 'no-store, must-revalidate',
    });
    if (req.method === 'HEAD') return res.end();

    const stream = createReadStream(found.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

/* ---- the `make dev` entry point ---- */

/** Best-effort browser open. A dev server that dies because `open` is missing
    would be a worse tool than one that just prints a URL. */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch { /* printing the URL is enough */ }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.argv[2] || process.env.PORT || 8000);
  const root = new URL('../', import.meta.url);
  const server = createDevServer({ root });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${port} is already in use.` +
        `\n  Stop what is there:  make stop PORT=${port}` +
        `\n  Or use another one:  make dev PORT=${port + 1}\n`,
      );
      process.exit(1);
    }
    throw err;
  });

  // Bound to the `localhost` hostname, not 0.0.0.0: this serves a working copy
  // of an unreleased branch, and it has no business on the local network.
  server.listen(port, 'localhost', () => {
    const url = `http://localhost:${port}/`;
    console.log(`\n  yootri  →  ${url}`);
    console.log('  Sign-in works on localhost; on 127.0.0.1 Firebase rejects it.');
    console.log('  Ctrl-C to stop.\n');
    if (process.env.OPEN !== '0') openBrowser(url);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}
