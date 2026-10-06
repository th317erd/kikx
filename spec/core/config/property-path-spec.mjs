'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  envKeyFor,
  joinPropertyPath,
  normalizePropertyPath,
} from '../../../src/core/config/property-path.mjs';

test('normalizePropertyPath leaves an already-normal path unchanged', () => {
  assert.equal(normalizePropertyPath('/a/b'), '/a/b');
});

test('normalizePropertyPath adds a missing leading slash', () => {
  assert.equal(normalizePropertyPath('a/b'), '/a/b');
});

test('normalizePropertyPath trims, collapses separators and drops the trailing slash', () => {
  assert.equal(normalizePropertyPath('  /a//b/  '), '/a/b');
  assert.equal(normalizePropertyPath('///org///aeor//'), '/org/aeor');
});

test('normalizePropertyPath maps the empty/root cases to "/"', () => {
  assert.equal(normalizePropertyPath('/'), '/');
  assert.equal(normalizePropertyPath('///'), '/');
});

test('normalizePropertyPath rejects non-strings and empty strings', () => {
  assert.throws(() => normalizePropertyPath(42), TypeError);
  assert.throws(() => normalizePropertyPath(null), TypeError);
  assert.throws(() => normalizePropertyPath(undefined), TypeError);
  assert.throws(() => normalizePropertyPath(''), TypeError);
  assert.throws(() => normalizePropertyPath('   '), TypeError);
});

test('envKeyFor derives canonical env keys', () => {
  let cases = [
    ['/org/aeor/kikx/database/driver', 'ORG_AEOR_KIKX_DATABASE_DRIVER'],
    ['/org/aeor/kikx/database/config/hostname', 'ORG_AEOR_KIKX_DATABASE_CONFIG_HOSTNAME'],
    ['plugin-paths', 'PLUGIN_PATHS'],
    ['/org/aeor/plugin-paths', 'ORG_AEOR_PLUGIN_PATHS'],
    ['/a/b.c@1', 'A_B_C_1'],
  ];

  for (const [path, expected] of cases)
    assert.equal(envKeyFor(path), expected, path);
});

test('envKeyFor normalizes the path before deriving the key', () => {
  assert.equal(envKeyFor('  org//aeor/kikx/  '), 'ORG_AEOR_KIKX');
});

test('envKeyFor maps distinct near-colliding paths to the same env key', () => {
  // The sanitizer is lossy, so these four distinct config keys all derive the
  // same env key. Config key lists must avoid near-collisions because
  // process-env lookup cannot distinguish them.
  let collidingPaths = ['/a-b', '/a_b', '/a.b', '/a@b'];

  for (const propertyPath of collidingPaths)
    assert.equal(envKeyFor(propertyPath), 'A_B', propertyPath);

  assert.equal(new Set(collidingPaths.map((propertyPath) => envKeyFor(propertyPath))).size, 1);
});

test('joinPropertyPath combines a base and segments', () => {
  assert.equal(joinPropertyPath('/org/aeor', 'kikx', 'database'), '/org/aeor/kikx/database');
  assert.equal(joinPropertyPath('/org', 'kikx/plugins'), '/org/kikx/plugins');
  assert.equal(joinPropertyPath('/', 'org', 'aeor'), '/org/aeor');
});

test('joinPropertyPath sanitizes empty and repeated separators', () => {
  assert.equal(joinPropertyPath('/org//aeor/', '', 'kikx'), '/org/aeor/kikx');
  assert.equal(joinPropertyPath('/org', 'kikx', '//database//'), '/org/kikx/database');
  assert.equal(joinPropertyPath('/'), '/');
  assert.equal(joinPropertyPath('/org/', ''), '/org');
});
