import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import { createDevServer } from '../tools/dev-server.mjs';

/* The dev server exists so `make dev` behaves the way GitHub Pages does, and
   every way it can quietly fail to is invisible in a browser until it bites:

   - a wrong Content-Type on a `.js` file makes the browser refuse the module,
     and the page comes up with no engine behind it at all,
   - a cached index.html makes an edit look like it did not happen,
   - a 404 answered with index.html would hide the case-wrong asset path that
     tests/index-html.test.js exists to catch and that only 404s on Pages,
   - and a path that climbs out of the repo root would hand the developer's
     filesystem to anything that can reach the port.

   So these drive a real server over a real socket. Nothing is mocked; every
   assertion is on bytes that came back off a TCP connection. */

const ROOT = new URL('../', import.meta.url);

/* Requests go out over a raw socket rather than through fetch() on purpose.
   `new URL()` collapses `..` segments — and the `%2e%2e` spelling with them —
   before undici ever writes the request line, so a traversal test built on
   fetch() would be asserting that Node's URL parser works, not that this server
   does. A hand-rolled request line is the only way to put a path on the wire
   exactly as written. */
function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`${method} ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, split).split('\r\n');
      const headers = {};
      for (const line of head.slice(1)) {
        const at = line.indexOf(':');
        headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({ status: Number(head[0].split(' ')[1]), headers, body: raw.slice(split + 4) });
    });
  });
}

const get = (port, path) => request(port, 'GET', path);

/** Run `fn` against a freshly started server, then always shut it down. */
async function withServer(fn, root = ROOT) {
  const server = createDevServer({ root });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((res) => server.close(res));
  }
}

test('serves index.html at the root', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /<!doctype html>/i);
  });
});

test('serves engine modules as JavaScript, or the browser refuses them', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/assets/coach/season.js');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.body, /export/);
  });
});

test('serves the stylesheet as CSS', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/assets/nocturne.css');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/css/);
  });
});

test('never lets the browser cache what is being edited', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/');
    assert.match(res.headers['cache-control'], /no-store/);
  });
});

test('ignores the query string when resolving a file', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/assets/coach/duration.js?v=1');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
  });
});

test('decodes percent-escapes in the path', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/assets/coach/legacy%2Dplan.js');
    assert.equal(res.status, 200);
  });
});

test('404s a missing file instead of falling back to index.html', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/assets/coach/no-such-module.js');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, /<title>/, 'a 404 must not be the app');
  });
});

/* The reason this one matters is macOS. `assets/coach/Season.js` opens happily
   on a case-insensitive filesystem and 404s on Pages, which is the single most
   annoying way to discover a typo — after a merge, in production. This assertion
   is free on Linux, where the filesystem enforces it, and is the whole point of
   the check on the machine this is actually developed on. */
test('404s a path whose case does not match the file on disk, as Pages will', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/assets/coach/Season.js');
    assert.equal(res.status, 404);
  });
});

test('404s a directory that has no index.html of its own', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/assets/coach/');
    assert.equal(res.status, 404);
  });
});

/* Rooted at assets/ so `..` has somewhere real to climb to: package.json is one
   level up, it is definitely there, and its contents are recognisable. */
test('refuses a path that climbs out of the root', async () => {
  await withServer(async (port) => {
    for (const path of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/package.json', '/coach/../../package.json']) {
      const res = await get(port, path);
      assert.notEqual(res.status, 200, `${path} was served`);
      assert.doesNotMatch(res.body, /"name": "yootri"/, `${path} leaked package.json`);
    }
  }, new URL('assets/', ROOT));
});

test('rejects a method other than GET or HEAD', async () => {
  await withServer(async (port) => {
    const res = await request(port, 'DELETE', '/index.html');
    assert.equal(res.status, 405);
  });
});

test('answers HEAD with the headers but no body', async () => {
  await withServer(async (port) => {
    const res = await request(port, 'HEAD', '/index.html');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.equal(res.body, '');
  });
});
