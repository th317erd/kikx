'use strict';

// Cache-busted static delivery.
//
// Cloudflare rewrites the origin's `Cache-Control: no-cache` to
// `max-age=14400` for every `.css` URL (and vendor `.js`), and strips the ETag
// while stamping its own `Last-Modified`, so a client cannot revalidate early.
// A stylesheet whose URL never changes therefore stays stale for four hours
// after a deploy. See docs/deploy-3098-runbook-20261031.md:38 "module URLs are
// not cache-busted" and the composer artifact report.
//
// The contract these tests pin:
//   - index.html links every stylesheet with a content-derived `?v=`.
//   - every served stylesheet stamps its own `@import` specifiers, so the
//     nested sheets cannot go stale behind a fresh parent.
//   - every served stylesheet stamps its own `url()` payloads, so a font
//     cannot go stale behind a fresh sheet, and the sheet's version moves when
//     the font does.
//   - a stamped URL still serves the exact bytes of the file on disk.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import {
  assetVersionForFile,
  clearAssetVersionCache,
  renderedCSSVersion,
  stampCSSImports,
  stampHTMLAssets,
} from '../../src/server/asset-stamping.mjs';

delete process.env.KIKX_PLUGIN_PATHS;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '../../src/client');
const VERSION_RE = /^[0-9a-f]{12}$/;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withServer(run) {
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      pluginRegistry: new PluginRegistry({ logger: { warn() {} } }),
      builtInToolsRegistered: true,
    }),
  });
  let baseURL = await listen(server);
  try {
    return await run(baseURL);
  } finally {
    await close(server);
  }
}

// Pull every <link rel="stylesheet" href="..."> out of the served document.
function stylesheetHrefs(html) {
  let hrefs = [];
  let re = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi;
  let match;
  while ((match = re.exec(html)) !== null)
    hrefs.push(match[1]);
  return hrefs;
}

test('index.html stamps every stylesheet with a content version', async () => {
  await withServer(async (baseURL) => {
    let response = await fetch(`${baseURL}/`);
    assert.equal(response.status, 200);
    let html = await response.text();
    let hrefs = stylesheetHrefs(html);

    assert.ok(hrefs.length >= 20, `expected the full stylesheet set, saw ${hrefs.length}`);
    assert.ok(
      html.includes('/client/styles/app.css?v='),
      'the entry stylesheet must be versioned — it is the parent of every @import',
    );

    for (let href of hrefs) {
      let version = new URL(href, 'http://x').searchParams.get('v');
      assert.ok(version, `stylesheet left unversioned: ${href}`);
      assert.match(version, VERSION_RE, `stylesheet version is not a content hash: ${href}`);
    }
  });
});

test('index.html keeps no-cache on the document itself', async () => {
  await withServer(async (baseURL) => {
    let response = await fetch(`${baseURL}/`);
    // The stamped HTML must never be cached, or the stamps themselves go stale.
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  });
});

test('a served stylesheet stamps its own @import specifiers', async () => {
  await withServer(async (baseURL) => {
    let response = await fetch(`${baseURL}/client/styles/app.css`);
    assert.equal(response.status, 200);
    let css = await response.text();

    let specifiers = [];
    let re = /@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let match;
    while ((match = re.exec(css)) !== null)
      specifiers.push(match[2]);

    assert.ok(specifiers.length >= 10, `app.css should import its split sheets, saw ${specifiers.length}`);
    for (let spec of specifiers) {
      let version = new URL(spec, 'http://x/client/styles/').searchParams.get('v');
      assert.ok(version, `@import left unversioned: ${spec}`);
      assert.match(version, VERSION_RE, `@import version is not a content hash: ${spec}`);
    }
  });
});

test('nested @import sheets are stamped too (questions.css)', async () => {
  await withServer(async (baseURL) => {
    let response = await fetch(`${baseURL}/client/styles/questions.css`);
    let css = await response.text();
    let specifiers = [ ...css.matchAll(/@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/g) ].map((m) => m[2]);

    assert.ok(specifiers.length >= 3, 'questions.css imports three sheets');
    for (let spec of specifiers) {
      assert.ok(
        new URL(spec, 'http://x/client/styles/').searchParams.get('v'),
        `nested @import left unversioned: ${spec}`,
      );
    }
  });
});

// A stamped URL must still return the sheet's exact bytes. The subject has to
// be a sheet index.html actually links: `app-composer.css` is never a <link>,
// it only arrives through app.css's @import, so looking for it in the document
// asserts something the design makes impossible. `statusbar-stats.css` is a
// direct link and imports nothing, which is what this assertion needs.
test('a stamped stylesheet URL serves the exact bytes on disk', async () => {
  await withServer(async (baseURL) => {
    let html = await (await fetch(`${baseURL}/`)).text();
    let href = stylesheetHrefs(html).find((h) => h.startsWith('/client/styles/statusbar-stats.css?v='));
    assert.ok(href, 'statusbar-stats.css should be stamped in the document');

    let response = await fetch(`${baseURL}${href}`);
    assert.equal(response.status, 200, 'a stamped URL must not 404');

    let served = Buffer.from(await response.arrayBuffer());
    let onDisk = await fsp.readFile(path.join(CLIENT_ROOT, 'styles/statusbar-stats.css'));
    assert.deepEqual(served, onDisk, 'stamping must not alter stylesheet bytes');
  });
});

// The @import chain is the layer that actually went stale: a fresh parent with
// unversioned children still serves a four-hour-old composer. Following the
// stamped specifier from app.css must land on the real sheet's bytes.
test('a sheet reached through a stamped @import serves the exact bytes on disk', async () => {
  await withServer(async (baseURL) => {
    let css = await (await fetch(`${baseURL}/client/styles/app.css`)).text();
    let spec = [ ...css.matchAll(/@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/g) ]
      .map((m) => m[2])
      .find((s) => s.startsWith('./app-composer.css?v='));
    assert.ok(spec, 'app.css must stamp its app-composer.css specifier');

    let response = await fetch(new URL(spec, `${baseURL}/client/styles/`));
    assert.equal(response.status, 200, 'a stamped @import target must not 404');

    let served = Buffer.from(await response.arrayBuffer());
    let onDisk = await fsp.readFile(path.join(CLIENT_ROOT, 'styles/app-composer.css'));
    assert.deepEqual(served, onDisk, 'the imported sheet must be served unmodified');
  });
});

test('the version tracks content, and is reused while content is unchanged', async () => {
  let dir = await fsp.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'kikx-stamp-'));
  let file = path.join(dir, 'thing.css');
  try {
    clearAssetVersionCache();
    await fsp.writeFile(file, '.a{color:red}');
    let first = await assetVersionForFile(file);
    assert.match(first, VERSION_RE);

    // Same content: cached, identical.
    assert.equal(await assetVersionForFile(file), first);

    // Different content: a new version, with a real mtime bump.
    await fsp.writeFile(file, '.a{color:blue}');
    let future = new Date(Date.now() + 5000);
    await fsp.utimes(file, future, future);
    let second = await assetVersionForFile(file);
    assert.match(second, VERSION_RE);
    assert.notEqual(second, first, 'changed content must produce a new version');

    assert.equal(await assetVersionForFile(path.join(dir, 'missing.css')), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Negative control for the pure transforms: with no resolvable version, the
// text must come out byte-identical. This is what proves the stamping is the
// thing doing the work rather than the fixture already containing ?v=.
test('transforms are inert when nothing resolves (negative control)', async () => {
  let html = '<link rel="stylesheet" href="/client/styles/app.css">';
  assert.equal(await stampHTMLAssets(html, { resolveVersion: async () => null }), html);

  let css = '@import url("./app-thread.css");';
  assert.equal(await stampCSSImports(css, async () => null), css);

  // Remote and non-CSS references are never rewritten.
  let remote = '@import url("https://example.com/x.css");';
  assert.equal(await stampCSSImports(remote, async () => 'deadbeef1234'), remote);
});

// ── @font-face url() payloads ───────────────────────────────────────────────
//
// globals.css declares four `@font-face` blocks whose `src: url('../fonts/…woff2')`
// payloads are edge-cached at `max-age=14400` exactly like every other asset.
// The `@import` rewriter never touched them, so a font change ships behind an
// unchanged URL — the same defect as the composer artifact, one layer deeper.
//
// Verified live 2026-11-07: all four fonts returned 200 with
// `cache-control: max-age=14400` through https://kikx3.taraani.org while the
// document's globals.css link carried a content version.

test('a served stylesheet stamps its @font-face url() payloads', async () => {
  await withServer(async (baseURL) => {
    let html = await (await fetch(`${baseURL}/`)).text();
    let href = stylesheetHrefs(html).find((h) => h.includes('/styles/globals.css'));
    assert.ok(href, 'globals.css should be linked from the document');

    let css = await (await fetch(`${baseURL}${href}`)).text();
    let payloads = [ ...css.matchAll(/src:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/g) ].map((m) => m[2]);
    assert.ok(payloads.length >= 4, `expected the four @font-face sources, saw ${payloads.length}`);

    for (let payload of payloads) {
      let version = new URL(payload, `${baseURL}${href}`).searchParams.get('v');
      assert.ok(version, `@font-face url() left unversioned: ${payload}`);
      assert.match(version, VERSION_RE, `font version is not a content hash: ${payload}`);
    }
  });
});

test('a stamped @font-face URL serves the font, not a 404', async () => {
  await withServer(async (baseURL) => {
    let html = await (await fetch(`${baseURL}/`)).text();
    let href = stylesheetHrefs(html).find((h) => h.includes('/styles/globals.css'));
    let css = await (await fetch(`${baseURL}${href}`)).text();
    let payload = [ ...css.matchAll(/src:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/g) ].map((m) => m[2])[0];
    assert.ok(payload, 'globals.css should declare a font source');

    let response = await fetch(new URL(payload, `${baseURL}${href}`));
    assert.equal(response.status, 200, 'a stamped font URL must not 404');
    assert.ok(
      Number(response.headers.get('content-length')) > 1000,
      'a real woff2 should come back, not a placeholder',
    );
  });
});

// Stamping the payload is half the fix. The other half is that the sheet's own
// `?v=` must move when the font changes — otherwise a fresh sheet URL still
// points at a four-hour-old `.woff2` and the glyphs are wrong behind a URL the
// browser has never seen. `stampCSSUrls` returns a stat fingerprint for each
// payload and `renderSheet` folds it into the version it hashes.
//
// Measured on this code: `02b18b768d1c` -> `886ab8a2c002` after rewriting the
// referenced font; `02b18b768d1c` unchanged after rewriting an unreferenced one;
// back to `02b18b768d1c` when the font bytes are restored.
test('editing a font payload moves the version of the sheet that references it', async () => {
  let root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kikx-font-version-'));
  try {
    await fsp.mkdir(path.join(root, 'styles'), { recursive: true });
    await fsp.mkdir(path.join(root, 'fonts'), { recursive: true });

    let referenced = path.join(root, 'fonts/a.woff2');
    let unreferenced = path.join(root, 'fonts/unused.woff2');
    await fsp.writeFile(referenced, Buffer.alloc(2048, 1));
    await fsp.writeFile(unreferenced, Buffer.alloc(2048, 2));

    let sheet = path.join(root, 'styles/globals.css');
    let original = [
      '@font-face { font-family: X; src: url("../fonts/a.woff2") format("woff2"); }',
      '.a { background: url("../fonts/a.woff2"); }',
      '',
    ].join('\n');
    await fsp.writeFile(sheet, original);

    let roots = { clientRoot: root, aeorWebComponentsRoot: null };
    let first = await renderedCSSVersion(sheet, roots);
    assert.match(first, VERSION_RE, 'a sheet with a font payload must still be versioned');

    // An unreferenced font must not churn the URL. A version that moved on any
    // font edit anywhere in the tree would bust every sheet on every font build.
    await fsp.writeFile(unreferenced, Buffer.alloc(4096, 3));
    assert.equal(
      await renderedCSSVersion(sheet, roots),
      first,
      'an unreferenced font must not move the sheet version',
    );

    // The referenced payload is the case that matters.
    await fsp.writeFile(referenced, Buffer.alloc(3000, 9));
    assert.notEqual(
      await renderedCSSVersion(sheet, roots),
      first,
      'a rewritten font payload must move the sheet version',
    );

    // Restoring the bytes restores the version, so the version is a function of
    // content and not of when the stat happened to run.
    await fsp.writeFile(referenced, Buffer.alloc(2048, 1));
    assert.equal(
      await renderedCSSVersion(sheet, roots),
      first,
      'restoring the font bytes must restore the sheet version',
    );

    // Negative control: hashing the text as it sits on disk — the behaviour
    // before this change — is blind to the font, so it cannot move. Without this
    // arm the assertions above could pass on a version derived from anything.
    let preStamp = crypto.createHash('sha256').update(original).digest('hex').slice(0, 12);
    assert.notEqual(
      first,
      preStamp,
      'the shipped version must not be the pre-stamp text hash',
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// `@import` and `url()` are different specifier kinds but the same syntax. A
// second rewrite pass must never produce `?v=a?v=b` — that URL would 404.
test('stamping never stacks two versions on one specifier', async () => {
  await withServer(async (baseURL) => {
    let css = await (await fetch(`${baseURL}/client/styles/app.css`)).text();
    for (let match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      let versions = (match[2].match(/\?v=/g) || []).length;
      assert.equal(versions <= 1, true, `specifier carries two versions: ${match[2]}`);
    }
  });
});
