'use strict';

import '../../support/test-env.mjs';

// Properties-store P2 (plan §4): grants are read/write SEPARATE maps,
// DENY beats ALLOW, default is DENY, wildcards are prefix-only and may be
// bare '/*' (backup/audit plugins — owner). Grants ride the signed manifest,
// so registration input is validated like a security boundary: malformed
// shapes refuse at load, never half-register. The FQID is registry-UNIQUE:
// the same pluginID from a DIFFERENT plugin path is a collision (refused),
// while the same path re-registering (reload) replaces cleanly.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GrantsRegistry,
  normalizePluginID,
} from '../../../src/core/properties/grants.mjs';

function expectCode(fn, code, why) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, `${why}: must throw an Error`);
    assert.equal(error.code, code, `${why}: expected ${code}, got ${error.code} (${error.message})`);
    return true;
  }, why);
}

const FULL_ACCESS = {
  read: { deny: [ '/core/kikx/email/*' ], allow: [ '/core/kikx/email/configuration', '/other/x' ] },
  // Bare '*' is the plan §4 idiom ("deny": "*") — accepted in EITHER map and
  // coerced to the whole absolute tree '/*'.
  write: { deny: [ '*' ], allow: [] },
};

test('FQID: path-form, at least three segments, normalized — anything else refused', () => {
  assert.equal(normalizePluginID('/Org/Category/Name'), '/org/category/name');
  assert.equal(normalizePluginID('/kikx/plugins/discord'), '/kikx/plugins/discord');
  assert.equal(normalizePluginID('/a/b/c/d/e'), '/a/b/c/d/e', 'deep paths are legal (Java-style)');
  for (const bad of [ 'org/cat/name', '/org/cat', '/a', '/', '', null, undefined, 42, '/org//cat' ]) {
    expectCode(() => normalizePluginID(bad), 'property_plugin_id_invalid',
      `pluginID ${JSON.stringify(bad)}`);
  }
});

test('access shapes: both maps optional, string-or-array forms, prefix-only wildcards', () => {
  const registry = new GrantsRegistry();
  // Partial manifest: only read declared; write defaults to empty maps.
  registry.register('/org/test/partial', { read: { allow: [ '/core/x' ] } }, '/path/a');
  const decision = registry.evaluate('plugin:/org/test/partial', 'write', '/core/x');
  assert.equal(decision.allowed, false, 'undeclared write = default deny');
  assert.equal(decision.reason, 'no-grant');

  // Plan §4's LITERAL example shape: bare '*' as a STRING, allow as array.
  // FLAT deny-wins (§4 prose: "deny beats allow"): an allow UNDER a covering
  // deny is DEAD — the example demonstrates SHAPE; a carve-out needs a
  // non-covering deny (P8 docs note this beside the example).
  registry.register('/org/test/plan-literal', {
    read: { deny: '*', allow: [ '/core/kikx/email/configuration' ] },
    write: { deny: '*', allow: [] },
  }, '/path/plan');
  assert.equal(registry.evaluate('plugin:/org/test/plan-literal', 'read', '/core/kikx/email/configuration').allowed,
    false, 'flat deny-wins: deny "*" covers even its own allow');
  assert.equal(registry.evaluate('plugin:/org/test/plan-literal', 'read', '/core/kikx/email/configuration').reason,
    'deny');
  assert.equal(registry.evaluate('plugin:/org/test/plan-literal', 'read', '/other/key').allowed, false,
    'string deny "*" covers everything else too');
  // A bare string where an array is expected also works (single entry).
  registry.register('/org/test/string-entry', { read: { allow: '/core/y' } }, '/path/str');
  assert.equal(registry.evaluate('plugin:/org/test/string-entry', 'read', '/core/y').allowed, true);

  for (const badAccess of [
    { read: 'nope' },                       // map must be an object
    { read: { allow: [ 42 ] } },            // entries must be strings
    { read: { allow: [ '**' ] } },          // star only as the full prefix idiom
    { read: { allow: [ '/mid*' ] } },       // mid-string wildcard refused
    { read: { allow: [ 'relative/x' ] }, }, // absolute keys only
    { read: { deny: null } },               // arrays/strings only — null refused
    { bogus: {} },                          // unknown top-level key
  ]) {
    expectCode(() => registry.register('/org/test/bad', badAccess, '/path/b'),
      'property_grant_invalid', `access ${JSON.stringify(badAccess)}`);
  }
  expectCode(() => registry.register('not-an-fqid', FULL_ACCESS, '/path/b'),
    'property_plugin_id_invalid', 'bad pluginID');
  expectCode(() => registry.register('/org/test/bad', 'nope', '/path/b'),
    'property_grant_invalid', 'non-object access');
});

test('deny beats allow; default is deny; /* covers the whole absolute tree', () => {
  const registry = new GrantsRegistry();
  registry.register('/org/test/demo', FULL_ACCESS, '/path/demo');

  // deny /core/kikx/email/* COVERS the sibling allow beneath it — FLAT
  // deny-wins kills it (the allow is dead while the deny stands).
  const coveredAllow = registry.evaluate('plugin:/org/test/demo', 'read', '/core/kikx/email/configuration');
  assert.equal(coveredAllow.allowed, false, 'flat deny-wins over a covered allow');
  assert.equal(coveredAllow.reason, 'deny', 'deny wins over the sibling allow');

  // The allow OUTSIDE the denied subtree holds.
  const allowed = registry.evaluate('plugin:/org/test/demo', 'read', '/other/x');
  assert.equal(allowed.allowed, true, 'sibling allow outside any deny');
  assert.equal(allowed.reason, 'allow');

  // write.deny '*' + empty allow = nothing writable.
  assert.equal(registry.evaluate('plugin:/org/test/demo', 'write', '/core/x').allowed, false);
  assert.equal(registry.evaluate('plugin:/org/test/demo', 'write', '/anything').allowed, false);

  // Unregistered absolute key = default deny.
  const never = registry.evaluate('plugin:/org/test/demo', 'read', '/totally/new');
  assert.equal(never.allowed, false);
  assert.equal(never.reason, 'no-grant');

  // /* grant: whole tree, subtree semantics only (bare node excluded).
  registry.register('/org/test/backup', { read: { allow: [ '/*' ] } }, '/path/backup');
  assert.equal(registry.evaluate('plugin:/org/test/backup', 'read', '/anything/at/all').allowed, true);
  assert.equal(registry.evaluate('plugin:/org/test/backup', 'read', '/deep/nested/key').allowed, true);

  // Exact entries never match siblings; prefix entries never match the bare node.
  registry.register('/org/test/exact', { read: { allow: [ '/core/x' ] } }, '/path/exact');
  assert.equal(registry.evaluate('plugin:/org/test/exact', 'read', '/core/xy').allowed, false);
  registry.register('/org/test/prefix', { read: { allow: [ '/core/x/*' ] } }, '/path/prefix');
  assert.equal(registry.evaluate('plugin:/org/test/prefix', 'read', '/core/x').allowed, false);
  assert.equal(registry.evaluate('plugin:/org/test/prefix', 'read', '/core/x/y/z').allowed, true);

  // An unregistered caller is default-deny on every action.
  assert.equal(registry.evaluate('plugin:/org/unknown/plugin', 'read', '/core/x').allowed, false);
});

test('FQID uniqueness: same path replaces (reload), different path collides and refuses', () => {
  const registry = new GrantsRegistry();
  registry.register('/org/test/demo', { read: { allow: [ '/a' ] } }, '/path/demo');
  // Reload of the SAME directory replaces cleanly.
  registry.register('/org/test/demo', { read: { allow: [ '/b' ] } }, '/path/demo');
  assert.equal(registry.evaluate('plugin:/org/test/demo', 'read', '/a').allowed, false,
    'reload replaced the old grants');
  assert.equal(registry.evaluate('plugin:/org/test/demo', 'read', '/b').allowed, true);
  // A different directory claiming the same pluginID is a collision.
  expectCode(
    () => registry.register('/org/test/demo', { read: { allow: [ '/*' ] } }, '/path/impostor'),
    'property_grant_duplicate',
    'pluginID collision from another path',
  );
  // Unregistration (unload) releases the id.
  registry.unregister('/org/test/demo', '/path/demo');
  assert.equal(registry.get('/org/test/demo'), null);
  registry.register('/org/test/demo', { read: { allow: [ '/c' ] } }, '/path/impostor');
  assert.equal(registry.evaluate('plugin:/org/test/demo', 'read', '/c').allowed, true);
});

test('evaluation never throws: malformed caller strings are a non-match, not a crash', () => {
  const registry = new GrantsRegistry();
  registry.register('/org/test/demo', FULL_ACCESS, '/path/demo');
  for (const caller of [ null, undefined, '', 'core', 'plugin:', 'plugin:nope', 42, 'user:x' ]) {
    const decision = registry.evaluate(caller, 'read', '/core/x');
    assert.equal(decision.allowed, false, `caller ${JSON.stringify(caller)} must not match`);
  }
});
