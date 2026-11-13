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
  // Evaluation = AeorDB-inspired (owner Q2, 2026-11-13; cf. aeordb
  // permission_resolver.rs "nearest level with an opinion wins, deny wins at
  // the same level"): the exact allow is NEARER than the root deny, so the
  // example works as written.
  registry.register('/org/test/plan-literal', {
    read: { deny: '*', allow: [ '/core/kikx/email/configuration' ] },
    write: { deny: '*', allow: [] },
  }, '/path/plan');
  assert.equal(registry.evaluate('plugin:/org/test/plan-literal', 'read', '/core/kikx/email/configuration').allowed,
    true, 'specific allow beats the broad "*" deny — the §4 example works as written');
  assert.equal(registry.evaluate('plugin:/org/test/plan-literal', 'read', '/core/kikx/email/configuration').reason,
    'allow');
  assert.equal(registry.evaluate('plugin:/org/test/plan-literal', 'read', '/other/key').allowed, false,
    'the "*" deny still covers everything without a nearer allow');
  assert.equal(registry.evaluate('plugin:/org/test/plan-literal', 'read', '/other/key').reason, 'deny');
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

test('nearest declaration wins, deny decides ties, default deny, /* covers the tree', () => {
  const registry = new GrantsRegistry();
  registry.register('/org/test/demo', FULL_ACCESS, '/path/demo');

  // AeorDB-inspired specificity: the EXACT allow is nearer than the prefix
  // deny, so "deny inside the subtree, allow this one key" expresses as written.
  const coveredAllow = registry.evaluate('plugin:/org/test/demo', 'read', '/core/kikx/email/configuration');
  assert.equal(coveredAllow.allowed, true, 'nearest (most specific) declaration wins');
  assert.equal(coveredAllow.reason, 'allow');

  // The allow OUTSIDE the denied subtree holds.
  const allowed = registry.evaluate('plugin:/org/test/demo', 'read', '/other/x');
  assert.equal(allowed.allowed, true, 'sibling allow outside any deny');
  assert.equal(allowed.reason, 'allow');

  // TIE at equal specificity → deny (AeorDB's same-level rule, deny writes last).
  registry.register('/org/test/tie', {
    read: { deny: [ '/core/x' ], allow: [ '/core/x' ] },
  }, '/path/tie');
  const tie = registry.evaluate('plugin:/org/test/tie', 'read', '/core/x');
  assert.equal(tie.allowed, false, 'equal-specificity conflict → deny');
  assert.equal(tie.reason, 'deny');

  // Longer prefix beats shorter prefix (nearest-level analogue).
  registry.register('/org/test/depth', {
    read: { deny: [ '/core/*' ], allow: [ '/core/allowed/*' ] },
  }, '/path/depth');
  assert.equal(registry.evaluate('plugin:/org/test/depth', 'read', '/core/allowed/deep/key').allowed, true,
    'nearer prefix wins over the broader deny');
  assert.equal(registry.evaluate('plugin:/org/test/depth', 'read', '/core/other/key').allowed, false,
    'only the denied/no-opinion side stays denied');

  // write.deny '*' + empty allow = nothing writable.
  assert.equal(registry.evaluate('plugin:/org/test/demo', 'write', '/core/x').allowed, false);
  assert.equal(registry.evaluate('plugin:/org/test/demo', 'write', '/anything').allowed, false);

  // Unregistered absolute key = default deny (no opinion anywhere).
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

test('{uuid} grant-segment token: matches exactly one segment; other tokens refused', () => {
  const registry = new GrantsRegistry();
  registry.register('/org/test/users', {
    read: { allow: [
      '/core/user/{UUID}/theme/primary_color',   // any user, this key only
      '/core/user/{uuid}/notes/*',               // any user, subtree (prefix+token)
    ] },
  }, '/path/users');
  // Manifest spelling {UUID} normalizes to {uuid} (lowercase fold).
  const user = 'plugin:/org/test/users';
  assert.equal(registry.evaluate(user, 'read', '/core/user/abc-123/theme/primary_color').allowed, true,
    'one segment substituted');
  assert.equal(registry.evaluate(user, 'read', '/core/user/abc-123/notes/today').allowed, true,
    'token inside a prefix form');
  assert.equal(registry.evaluate(user, 'read', '/core/user/abc-123/theme/accent').allowed, false,
    'literal tail still binds');
  assert.equal(registry.evaluate(user, 'read', '/core/user/abc-123/notes').allowed, false,
    'prefix form never matches the bare node');
  assert.equal(registry.evaluate(user, 'read', '/core/user/a/b/theme/primary_color').allowed, false,
    'the token is exactly ONE segment — no multi-segment swallow');

  // Tokens other than {uuid} are refused at registration; {current} is an
  // identity token — it belongs to the calculate step, never a grant pattern.
  for (const badPattern of [ '/core/{current}/x', '/core/{foo}/x', '/core/{uuid' ]) {
    expectCode(() => registry.register('/org/test/badtoken', { read: { allow: [ badPattern ] } }, '/path/bad'),
      'property_grant_invalid', `pattern ${badPattern}`);
  }
});
