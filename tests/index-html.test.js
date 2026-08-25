import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* index.html is the one file `npm test` cannot import: it is markup, and its
   module scripts touch the DOM on the way in. It is also where every engine
   module is actually wired up. With no build step and no bundler there is
   nothing between a rename in assets/coach/ and a live page that throws on
   load — the unit tests stay green because they never look at this file.

   So these tests read index.html as text and check the seams: that its module
   scripts parse, that every module they import exists, that every name they
   import is really exported, and that every asset the page asks the server for
   is in the repo. They are cheap and they only fail for real reasons. */

const ROOT = new URL('../', import.meta.url);
const HTML = readFileSync(new URL('index.html', ROOT), 'utf8');

const OPEN = '<script';
const CLOSE = '</script';

/** The `<script type="module">` blocks, each tagged with the line it opens on.

   Scanned by hand rather than with `/<script\b[^>]*>([\s\S]*?)<\/script>/gi`,
   which is the obvious way and is wrong twice over: HTML tag names are
   case-insensitive, and a browser ends a script at `</script foo="bar">` just
   as readily as at `</script>`. Neither is likely in a file we write ourselves
   — but a scanner that quietly finds nothing would make every check below pass
   for the wrong reason, and CodeQL flags the regex form on sight. */
function moduleScripts(html = HTML) {
  const hay = html.toLowerCase();
  const out = [];
  let i = 0;
  for (;;) {
    const open = hay.indexOf(OPEN, i);
    if (open === -1) return out;
    i = open + OPEN.length;
    if (/[a-z0-9]/.test(hay[i] || '')) continue;   // `<scripts…>` is a different tag
    const attrsEnd = hay.indexOf('>', i);
    if (attrsEnd === -1) return out;               // an unclosed tag: nothing to read
    const close = hay.indexOf(CLOSE, attrsEnd + 1);
    if (close === -1) return out;                  // unterminated: nothing to read
    const closeEnd = hay.indexOf('>', close);
    if (closeEnd === -1) return out;
    if (/\btype\s*=\s*['"]?module\b/i.test(html.slice(i, attrsEnd))) {
      out.push({
        line: html.slice(0, open).split('\n').length,
        body: html.slice(attrsEnd + 1, close),
      });
    }
    i = closeEnd + 1;
  }
}

/* Comments are stripped before scanning for imports so that a commented-out
   import, or the word `import` in prose, is not mistaken for a real one. The
   `[^:]` guard keeps `https://` from being read as the start of a comment. */
function withoutComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Every static import in a script: what it binds, and where from. */
function staticImports({ body, line }) {
  const out = [];
  const re = /^[ \t]*import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (let m; (m = re.exec(withoutComments(body))); ) {
    out.push({ clause: (m[1] || '').trim(), spec: m[2], line });
  }
  return out;
}

/** The names an import clause binds, before any `as` rename. */
function namedBindings(clause) {
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (!braced) return [];
  return braced[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+as\s+/)[0].trim());
}

/** True when the clause also takes a default export (`import x, { y } from`). */
function bindsDefault(clause) {
  const head = clause.split('{')[0].trim().replace(/,$/, '');
  return head !== '' && !head.startsWith('*');
}

const SCRIPTS = moduleScripts();
const IMPORTS = SCRIPTS.flatMap(staticImports);
const LOCAL = IMPORTS.filter((i) => i.spec.startsWith('.'));

test('the script scanner is not fooled by tag case or a lax closing tag', () => {
  const found = moduleScripts(
    '<SCRIPT TYPE="module">const a = 1;</SCRIPT foo="bar">' +
    '<script type="module">const b = 2;</script >' +
    '<script>const c = 3;</script>' +
    '<scripts type="module">not a script tag</scripts>',
  );
  assert.deepEqual(found.map((s) => s.body), ['const a = 1;', 'const b = 2;']);
});

test('index.html still has module scripts to check', () => {
  // Without this the three tests below would pass by finding nothing at all.
  assert.ok(SCRIPTS.length > 0, 'no <script type="module"> found in index.html');
  assert.ok(LOCAL.length > 0, 'index.html imports nothing from assets/coach/');
});

test('every module script in index.html parses as an ES module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yootri-html-'));
  for (const { line, body } of SCRIPTS) {
    const file = join(dir, `script-at-line-${line}.mjs`);
    writeFileSync(file, body);
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(
      res.status, 0,
      `the <script> opening at index.html:${line} does not parse.\n` +
      `Line numbers below are relative to that tag.\n${res.stderr}`,
    );
  }
});

test('every module index.html imports is a file in the repo', () => {
  for (const { spec } of LOCAL) {
    assert.ok(existsSync(new URL(spec, ROOT)), `index.html imports ${spec}, which does not exist`);
  }
});

test('every name index.html imports is exported by the module it comes from', async () => {
  /* A rename in the engine is caught here rather than in the browser. The
     modules are imported for real — they are pure, so this costs nothing. */
  for (const { spec, clause } of LOCAL) {
    const mod = await import(new URL(spec, ROOT).href);
    for (const name of namedBindings(clause)) {
      assert.ok(name in mod, `index.html imports { ${name} } from ${spec}, which does not export it`);
    }
    if (bindsDefault(clause)) {
      assert.ok('default' in mod, `index.html imports a default from ${spec}, which has none`);
    }
  }
});

/* ---- what the page asks the server for ---- */

/** Paths that are ours to serve: not a URL, not protocol-relative, not an anchor. */
function isLocalPath(ref) {
  return ref !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(ref);
}

test('every local asset index.html references is in the repo', () => {
  const refs = new Set();
  for (const m of HTML.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/gi)) refs.add(m[1]);
  // The example plan is fetched, not linked, and a 404 there is just as broken.
  for (const m of HTML.matchAll(/\bfetch\(\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);

  const local = [...refs].filter(isLocalPath);
  assert.ok(local.length > 0, 'no local asset references found — has the markup changed?');

  for (const ref of local) {
    // GitHub Pages serves this repo at the domain root, so a leading `/` is the
    // repo root too. Query strings and fragments are the browser's business.
    const path = ref.split(/[?#]/)[0].replace(/^\//, '');
    assert.ok(existsSync(new URL(path, ROOT)), `index.html references ${ref}, which is not in the repo`);
  }
});

/** The sizes a .ico actually carries, read from its ICONDIR. A 0 byte means 256. */
function icoSizes(buf) {
  const count = buf.readUInt16LE(4);
  return new Set(Array.from({ length: count }, (_, i) => {
    const e = 6 + i * 16;
    return `${buf[e] || 256}x${buf[e + 1] || 256}`;
  }));
}

test('a favicon link that advertises a size really has that size', () => {
  /* `sizes` is a promise to the browser: it picks an icon on the strength of
     this attribute and only then downloads it. Advertise 32x32 and ship a file
     holding nothing but a 16x16 and the tab gets a blurry upscale — with no
     error anywhere to say so. This caught exactly that. */
  const links = [...HTML.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/gi)].map((m) => m[0]);
  assert.ok(links.length > 0, 'index.html declares no icon links — has the markup changed?');

  let checked = 0;
  for (const tag of links) {
    const sizes = tag.match(/\bsizes="([^"]+)"/i);
    const href = tag.match(/\bhref="([^"]+)"/i);
    if (!sizes || !href || !href[1].endsWith('.ico')) continue;
    const path = href[1].split(/[?#]/)[0].replace(/^\//, '');
    const have = icoSizes(readFileSync(new URL(path, ROOT)));
    for (const want of sizes[1].trim().split(/\s+/)) {
      assert.ok(have.has(want), `${path} is linked as sizes="${want}" but holds only ${[...have].join(', ')}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no sized .ico link found — has the markup changed?');
});

/* ---- the boundary CLAUDE.md draws ---- */

test('the engine never reaches into the page', () => {
  /* assets/coach/ is testable in Node precisely because it has no DOM. A
     `document` or `localStorage` on a branch the unit tests happen not to hit
     would not fail anything until an athlete found it. */
  const forbidden = /\b(document|window|localStorage|sessionStorage|navigator|alert)\b/;
  const dir = new URL('assets/coach/', ROOT);
  const modules = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(modules.length > 0, 'no engine modules found');
  for (const name of modules) {
    const src = withoutComments(readFileSync(new URL(name, dir), 'utf8'));
    const hit = src.match(forbidden);
    assert.equal(hit, null, `assets/coach/${name} uses \`${hit && hit[0]}\` — the engine must stay DOM-free`);
  }
});

/* ---- the privacy notice cannot ship half-written ---- */

test('the privacy notice has a contact route and a named region', () => {
  /* Cloud sync makes this project the controller of somebody else's training
     data, and two facts in the notice cannot be derived from anything in the
     repo: how to reach the controller, and which region Firestore actually
     holds the data in. Blanking either is a failing test rather than a notice
     that quietly tells a user nothing — which is also what a fork hits until it
     puts its own values there (FIREBASE_SETUP.md, step 7). */
  for (const name of ['PRIVACY_CONTACT', 'PRIVACY_REGION']) {
    const m = HTML.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`));
    assert.ok(m, `${name} is gone from index.html — was the privacy notice removed?`);
    assert.notEqual(m[1].trim(), '', `${name} is still blank; the privacy notice would publish a placeholder`);
  }
});

test('no cloud call runs without consent', () => {
  /* Consent is enforced at each call site rather than behind one wrapper, which
     is the safer shape but only while every site actually carries the guard. A
     new path that forgets it would sync silently and the app would look fine. */
  for (const fn of ['schedulePush', 'pushPlan', 'cloudDelete']) {
    const m = HTML.match(new RegExp(`function ${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]{0,200})`));
    assert.ok(m, `${fn} is gone from index.html`);
    assert.match(m[1], /hasSyncConsent\(\)/, `${fn} no longer checks hasSyncConsent()`);
  }
});
