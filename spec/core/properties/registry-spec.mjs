'use strict';

import '../../support/test-env.mjs';

// Properties-store P2 (plan: docs/plans/properties-store.md §3): SENSITIVITY
// IS CORE-OWNED, never requester-owned — no self-granting. The registry maps
// absolute keys/patterns to public | internal | secret, most specific entry
// wins, and an unmatched absolute key defaults to 'internal' (grant-able,
// never accidentally world-readable). Wildcards are prefix-only: exact,
// '/prefix/*', or the root '/*' — nothing else.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CorePropertyRegistry,
  SENSITIVITIES,
  DEFAULT_PROPERTY_SENSITIVITIES,
} from '../../../src/core/properties/registry.mjs';

function expectCode(fn, code, why) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, `${why}: must throw an Error`);
    assert.equal(error.code, code, `${why}: expected ${code}, got ${error.code} (${error.message})`);
    return true;
  }, why);
}

test('the sensitivity vocabulary is exactly public | internal | secret', () => {
  assert.deepEqual([ ...SENSITIVITIES ], [ 'public', 'internal', 'secret' ]);
});

test('core defaults: email config is secret, theme is internal, nothing defaults public', () => {
  const registry = new CorePropertyRegistry();
  assert.equal(registry.lookup('/core/kikx/email/configuration'), 'secret');
  assert.equal(registry.lookup('/core/user/theme/primary_color'), 'internal');
  assert.equal(registry.lookup('/core/kikx/something/new'), 'internal', 'core subtree default');
  assert.equal(registry.lookup('/other/area/key'), 'internal', 'unmatched absolute default');
  assert.equal(registry.lookup('/anything'), 'internal');
  // Default entries are inspectable (docs/dump surfaces) — as patterns.
  assert.deepEqual(DEFAULT_PROPERTY_SENSITIVITIES.map(([ pattern ]) => pattern).sort(), [
    '/*', '/core/kikx/email/configuration', '/core/user/theme/primary_color', '/core/*',
  ].sort());
});

test('most specific entry wins: an exact row beats a prefix row beats the root', () => {
  const registry = new CorePropertyRegistry();
  registry.register('/core/docs/*', 'public');
  registry.register('/core/docs/readme', 'internal');
  assert.equal(registry.lookup('/core/docs/other'), 'public', 'prefix row');
  assert.equal(registry.lookup('/core/docs/readme'), 'internal', 'exact beats prefix');
  assert.equal(registry.lookup('/core/docs/readme/deeper'), 'public', 'prefix still governs its subtree');
  assert.equal(registry.lookup('/core/docs'), 'internal', 'prefix /core/docs/* does NOT match the bare node');
});

test('registry rows are validated: bad sensitivity, non-absolute, malformed wildcard', () => {
  const registry = new CorePropertyRegistry();
  expectCode(() => registry.register('/x/y', 'password'), 'property_registry_invalid', 'unknown sensitivity');
  expectCode(() => registry.register('/x/y', 42), 'property_registry_invalid', 'non-string sensitivity');
  expectCode(() => registry.register('relative/key', 'public'), 'property_registry_invalid', 'relative pattern');
  expectCode(() => registry.register('/x*', 'public'), 'property_registry_invalid', 'mid-string wildcard');
  expectCode(() => registry.register('*', 'public'), 'property_registry_invalid', 'bare wildcard');
  expectCode(() => registry.register('/x/y', ''), 'property_registry_invalid', 'empty sensitivity');
});

test('a custom entry set can be built for tests without touching core defaults', () => {
  const registry = new CorePropertyRegistry([
    [ '/probe/exact', 'secret' ],
    [ '/probe/*', 'public' ],
  ]);
  assert.equal(registry.lookup('/probe/exact'), 'secret');
  assert.equal(registry.lookup('/probe/other'), 'public');
  assert.equal(registry.lookup('/unrelated'), 'internal');
});
