'use strict';

// Real-browser coverage for the aeor-web-components framework itself.
//
// Why this spec lives here and not in the framework repo: the framework has no
// package.json, no node_modules and no DOM library — by design, it is a
// dependency-free browser library. Its test/component-regressions.mjs calls
// document.createElement, so it cannot run under bare Node at all, and until
// this spec existed nothing anywhere invoked it. That file had never executed
// once.
//
// Adding a Playwright dependency to the framework would give a zero-dependency
// library its first dependency purely to test it. Instead the framework ships
// a portable, human-openable page (test/harness.html) and each consumer project
// drives it with whatever browser runner it already has. This is kikx2's.
//
// What this proves:
//   1. runComponentRegressions() actually runs and passes — first execution ever.
//   2. cleanupBindings() genuinely unsubscribes: after the call a bound element
//      stops reacting to state changes. This is asserted behaviourally, because
//      asserting "the function was called" would pass even if it did nothing.
//
// Not covered by `npm test`: that glob is `spec/**/*-spec.mjs` and this lane is
// `*-playwright.mjs`. Run it explicitly (see the command in the repo docs).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { findChromeExecutable } from '../stagehand/stagehand-test-utils.mjs';

// The framework checkout. Override with AEOR_WEB_COMPONENTS_DIR on another host.
const FRAMEWORK_DIR = process.env.AEOR_WEB_COMPONENTS_DIR
  || path.resolve(process.env.HOME || '/home/wyatt', 'Projects/aeor-web-components');

const CONTENT_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

function startFrameworkServer(root) {
  let server = http.createServer(async (request, response) => {
    let pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);

    // Contain the served path inside the framework checkout.
    let target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(path.resolve(root))) {
      response.writeHead(403).end('forbidden');
      return;
    }

    try {
      let body = await fsp.readFile(target);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES.get(path.extname(target)) || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

// Flush the state's batched notifications. reactive-state coalesces writes, so
// a single microtask is not always enough; draining a few is deterministic and
// cheap.
const FLUSH = `await new Promise((r) => setTimeout(r, 0)); await Promise.resolve(); await Promise.resolve();`;

test('aeor-web-components: component regressions execute and pass in a real browser', async (t) => {
  if (!findChromeExecutable()) {
    t.skip('real-browser coverage requires Chrome; findChromeExecutable() found none');
    return;
  }

  assert.ok(fs.existsSync(FRAMEWORK_DIR), `framework checkout not found at ${FRAMEWORK_DIR}`);
  assert.ok(fs.existsSync(path.join(FRAMEWORK_DIR, 'test/harness.html')), 'framework test harness page missing');

  let server = await startFrameworkServer(FRAMEWORK_DIR);
  let browser;

  try {
    browser = await chromium.launch({
      // The guard above guarantees this is a real path. `|| undefined` used to
      // let a missing browser through to Playwright, which then threw instead
      // of the test skipping.
      executablePath: findChromeExecutable(),
      headless: true,
    });

    let page = await browser.newPage();
    let consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error')
        consoleErrors.push(message.text());
    });

    await page.goto(`${server.origin}/test/harness.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__harnessReady === true', null, { timeout: 15_000 });

    let result = await page.evaluate('window.__harness.run()');

    // This assertion is the point of the spec: it is the first time this file
    // has ever been executed, so a failure here is a real, previously invisible
    // framework defect rather than a flaky assertion.
    assert.equal(result.ok, true, `component regressions failed: ${result.error}`);
    assert.match(result.summary, /passed/i);

    assert.deepEqual(consoleErrors, [], `console/page errors during regressions: ${consoleErrors.join(' | ')}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test('cleanupBindings unsubscribes, so a disposed element stops reacting to state', async (t) => {
  if (!findChromeExecutable()) {
    t.skip('real-browser coverage requires Chrome; findChromeExecutable() found none');
    return;
  }

  let server = await startFrameworkServer(FRAMEWORK_DIR);
  let browser;

  try {
    browser = await chromium.launch({
      executablePath: findChromeExecutable() || undefined,
      headless: true,
    });

    let page = await browser.newPage();
    await page.goto(`${server.origin}/test/harness.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__harnessReady === true', null, { timeout: 15_000 });

    // Live control: before cleanup the binding must work, otherwise the
    // "stopped updating" assertion below would pass against a dead binding and
    // prove nothing.
    let live = await page.evaluate(`(async () => {
      const { elements, cleanupBindings } = await import('/elements.js');
      const { ReactiveState } = await import('/reactive-state.js');

      const owner = { _state: new ReactiveState({ name: 'Before' }) };
      const container = document.createElement('div');
      document.body.append(container);

      const node = elements.div.context(owner)(
        elements.span.textContent.bindState((state) => state.name, ['name'])(),
      ).build(document);
      container.append(node);

      const span = node.querySelector('span');
      const initial = span.textContent;

      owner._state.name = 'During';
      ${FLUSH}
      const afterLiveUpdate = span.textContent;

      const removed = cleanupBindings(container);

      owner._state.name = 'After';
      ${FLUSH}
      const afterCleanup = span.textContent;

      container.remove();
      return { initial, afterLiveUpdate, afterCleanup, removed };
    })()`);

    assert.equal(live.initial, 'Before', 'binding did not apply its initial value');
    assert.equal(live.afterLiveUpdate, 'During', 'binding did not update before cleanup — the control case is broken, so the test below would be vacuous');
    assert.ok(live.removed > 0, `cleanupBindings reported ${live.removed} cleanups; expected at least 1`);
    assert.equal(live.afterCleanup, 'During', 'element kept updating after cleanupBindings — the listener was not actually removed');

    // Idempotence: a second call must not double-unsubscribe or throw.
    let second = await page.evaluate(`(async () => {
      const { elements, cleanupBindings } = await import('/elements.js');
      const { ReactiveState } = await import('/reactive-state.js');

      const owner = { _state: new ReactiveState({ name: 'x' }) };
      const container = document.createElement('div');
      document.body.append(container);
      container.append(elements.div.context(owner)(
        elements.span.textContent.bindState((state) => state.name, ['name'])(),
      ).build(document));

      const first = cleanupBindings(container);
      const again = cleanupBindings(container);
      container.remove();
      return { first, again };
    })()`);

    assert.ok(second.first > 0, 'first cleanup pass found no bindings');
    assert.equal(second.again, 0, `second cleanup pass re-ran ${second.again} callbacks; it must be a no-op`);

    // Descendant coverage: the walk must reach nested bound nodes, not just root.
    let nested = await page.evaluate(`(async () => {
      const { elements, cleanupBindings } = await import('/elements.js');
      const { ReactiveState } = await import('/reactive-state.js');

      const owner = { _state: new ReactiveState({ inner: 'one' }) };
      const container = document.createElement('div');
      document.body.append(container);

      const node = elements.div.context(owner)(
        elements.div(
          elements.span.textContent.bindState((state) => state.inner, ['inner'])(),
          elements.span.textContent.bindState((state) => state.inner, ['inner'])(),
        ),
      ).build(document);
      container.append(node);

      const removed = cleanupBindings(container);
      owner._state.inner = 'two';
      ${FLUSH}
      const texts = [...container.querySelectorAll('span')].map((span) => span.textContent);
      container.remove();
      return { removed, texts };
    })()`);

    assert.equal(nested.removed, 2, `expected 2 nested bindings cleaned, got ${nested.removed}`);
    assert.deepEqual(nested.texts, ['one', 'one'], 'nested bound nodes kept updating after cleanup');

    // Nullish tolerance: callers tear down in a finally block and may not have
    // a built root yet.
    let nullish = await page.evaluate(`(async () => {
      const { cleanupBindings } = await import('/elements.js');
      return { undef: cleanupBindings(undefined), nul: cleanupBindings(null) };
    })()`);

    assert.equal(nullish.undef, 0, 'cleanupBindings(undefined) should be a no-op returning 0');
    assert.equal(nullish.nul, 0, 'cleanupBindings(null) should be a no-op returning 0');
  } finally {
    await browser?.close();
    await server.close();
  }
});
