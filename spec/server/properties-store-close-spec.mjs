'use strict';

// Regression: the properties store's pool must not outlive the server.
//
// Why this exists. `ensurePropertiesStore` opens its OWN pg pool (the document
// driver cannot be used — it resolves after plugins load). Nothing closed it:
// create-server registered 'close' handlers for memorySampler and
// runtimeEventGateway only. Production hides that (one server per process,
// then process.exit), but the unit lane boots 53 servers inside ONE file, so
// every un-closed pool held up to 10 of Postgres's 97 usable slots.
//
// Measured 2026-11-17: `spec/server/create-server-spec.mjs` alone peaked at 56
// live connections; the full parallel unit lane peaked at 96/97 and 23 tests
// died with `code: '53300' — remaining connection slots are reserved`. After
// these tests' subject landed, the same file peaks at 5.
//
// The subtle half is OWNERSHIP, which is why the assertions below are split:
// closing unconditionally would be wrong. A caller-injected store belongs to
// the caller — several suites boot more than one server from a single context,
// and closing on the first server's 'close' would hand the next one a dead
// pool. So the seam marks a context only when IT opened the store.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppContext } from '../../src/core/app/app-context.mjs';
import {
  ensurePropertiesStore,
  closeOwnedPropertiesStore,
  PROPERTIES_OWNED_KEY,
} from '../../src/server/properties-boot.mjs';

// The file whose 'close' wiring is guarded at the bottom of this spec.
const SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/server/create-server.mjs',
);

// A store stub that records close() calls. Deliberately not a real driver:
// the behaviour under test is ownership and lifetime, not SQL.
function stubStore({ closeImpl } = {}) {
  const store = {
    closes: 0,
    async close() {
      store.closes += 1;
      if (closeImpl) await closeImpl();
    },
  };
  return store;
}

function stubConfig() {
  return { get: async () => null };
}

test('an OPENED store marks its context as the owner', async () => {
  const context = new AppContext({});
  await ensurePropertiesStore({
    context,
    options: { properties: { driver: 'sqlite', filename: ':memory:' } },
    config: stubConfig(),
  });

  assert.equal(context.has('propertiesStore'), true, 'the store must be registered');
  assert.equal(context.has(PROPERTIES_OWNED_KEY), true, 'an opened store must be marked owned');
  await closeOwnedPropertiesStore(context);
});

test('closeOwnedPropertiesStore closes the store it opened and detaches it', async () => {
  const context = new AppContext({});
  const store = stubStore();
  context.set('propertiesStore', store);
  context.set(PROPERTIES_OWNED_KEY, true);

  const closed = await closeOwnedPropertiesStore(context);

  assert.equal(closed, true, 'an owned store must report that it was closed');
  assert.equal(store.closes, 1, 'close() must be called exactly once');
  assert.equal(context.has('propertiesStore'), false, 'the closed handle must be detached');
  assert.equal(context.has(PROPERTIES_OWNED_KEY), false, 'ownership must be cleared');
});

test('an INJECTED store is never closed — the caller owns it', async () => {
  const context = new AppContext({});
  const store = stubStore();

  await ensurePropertiesStore({
    context,
    options: { propertiesStore: store },
    config: stubConfig(),
  });

  assert.equal(context.require('propertiesStore'), store, 'the injected store must be used');
  assert.equal(context.has(PROPERTIES_OWNED_KEY), false, 'injection must NOT claim ownership');

  const closed = await closeOwnedPropertiesStore(context);

  assert.equal(closed, false, 'a non-owned store must not be closed');
  assert.equal(store.closes, 0, 'the caller keeps its handle open');
  assert.equal(context.require('propertiesStore'), store, 'the injected store must stay attached');
});

test('closing twice is a no-op, not a double close', async () => {
  const context = new AppContext({});
  const store = stubStore();
  context.set('propertiesStore', store);
  context.set(PROPERTIES_OWNED_KEY, true);

  assert.equal(await closeOwnedPropertiesStore(context), true);
  assert.equal(await closeOwnedPropertiesStore(context), false);
  assert.equal(store.closes, 1, 'the second call must not reach the store');
});

test('a context with no properties store is left alone', async () => {
  const context = new AppContext({});

  assert.equal(await closeOwnedPropertiesStore(context), false);
  assert.equal(context.has('propertiesStore'), false);
});

test('a failing close is swallowed — shutdown must never throw', async () => {
  const context = new AppContext({});
  const store = stubStore({ closeImpl: async () => { throw new Error('pool already ended'); } });
  context.set('propertiesStore', store);
  context.set(PROPERTIES_OWNED_KEY, true);

  // The handler in create-server runs inside a 'close' listener; a rejection
  // there would surface as an unhandled rejection during shutdown.
  const closed = await closeOwnedPropertiesStore(context);

  assert.equal(closed, false, 'a failed close is reported, not thrown');
  assert.equal(store.closes, 1, 'close() was attempted');
  assert.equal(context.has(PROPERTIES_OWNED_KEY), false, 'ownership is cleared even on failure');
});

test('a store with no close() is tolerated', async () => {
  const context = new AppContext({});
  context.set('propertiesStore', { get: async () => undefined });
  context.set(PROPERTIES_OWNED_KEY, true);

  assert.equal(await closeOwnedPropertiesStore(context), true);
  assert.equal(context.has('propertiesStore'), false);
});

// Wiring guard. The assertions above pin closeOwnedPropertiesStore's BEHAVIOUR,
// but measured on 2026-11-17 they stayed green after the server.on('close')
// registration was deleted from create-server.mjs — the function was correct
// and simply never called. A seam nobody invokes leaks exactly as much as no
// seam at all, so the call site is asserted rather than trusted.
//
// This is a source assertion, not behavioural: proving the handler fires needs
// a real driver and a connection census, which is what the lane-wide 53300
// failures measured. The static check is the cheap tripwire for the specific
// edit that would silently reintroduce the leak.
test('create-server registers the close handler that releases the store', async () => {
  const source = await readFile(SOURCE, 'utf8');

  assert.match(
    source,
    /server\.on\('close',\s*\(\)\s*=>\s*\{\s*closeOwnedPropertiesStore\(context\)/,
    'the properties store is never released on server close — its pool outlives the server',
  );
  assert.match(
    source,
    /import\s*\{[^}]*closeOwnedPropertiesStore[^}]*\}\s*from\s*'\.\/properties-boot\.mjs'/,
    'closeOwnedPropertiesStore must be imported from the seam',
  );
});
