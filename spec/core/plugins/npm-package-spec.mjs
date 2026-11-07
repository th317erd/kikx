'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseNpmPackageSpec } from '../../../src/core/plugins/npm-package.mjs';

// Campaign S3 (plan 5-S3): the install endpoint accepts {npm:"<pkg[@version|range]>"}.
// Validation is a strict regex — registry names and spaceless ranges only, never
// git+/file:/URLs/flags/spaces. This spec is the gate in front of an HTTPS fetch
// that downloads and executes code; every hostile shape must fall out as null.

test('accepts plain registry names', () => {
  for (const name of ['kikx-plugin-echo', 'left-pad', '@kikx/core', '@scope/name-2']) {
    const parsed = parseNpmPackageSpec(name);
    assert.ok(parsed, `must accept ${name}`);
    assert.equal(parsed.name, name);
    assert.equal(parsed.version, null, `${name} carries no version pin`);
  }
});

test('accepts pinned versions and spaceless ranges', () => {
  const cases = [
    ['foo@1.2.3', 'foo', '1.2.3'],
    ['foo@^2.0.0', 'foo', '^2.0.0'],
    ['foo@~1.2', 'foo', '~1.2'],
    ['foo@1.x', 'foo', '1.x'],
    ['foo@>=1.0.0', 'foo', '>=1.0.0'],
    ['foo@1.0.0-beta.1', 'foo', '1.0.0-beta.1'],
    ['@scope/name@1.2.3', '@scope/name', '1.2.3'],
  ];
  for (const [input, name, version] of cases) {
    const parsed = parseNpmPackageSpec(input);
    assert.ok(parsed, `must accept ${input}`);
    assert.equal(parsed.name, name);
    assert.equal(parsed.version, version);
  }
});

test('rejects shell/npm flags — they are argv, never a package spec', () => {
  for (const bad of ['--ignore-scripts', '-p', '--registry=http://evil', 'foo --ignore-scripts']) {
    assert.equal(parseNpmPackageSpec(bad), null, `must reject flag ${bad}`);
  }
});

test('rejects path and URL shapes', () => {
  for (const bad of [
    '../evil', './evil', '/abs/path', 'foo/../../bar', 'dir/sub',
    'git+ssh://git.example/x.git', 'file:/tmp/x', 'https://evil.example/x.tgz',
    'http://evil.example/x', 'x.tgz', 'user/repo',
  ]) {
    assert.equal(parseNpmPackageSpec(bad), null, `must reject ${bad}`);
  }
});

test('rejects spaces — ranges with spaces are out of scope, not parsed', () => {
  for (const bad of ['foo bar', 'foo@1.0.0 <2.0.0', 'foo@1 || 2', 'foo@1.0.0\n2.0.0']) {
    assert.equal(parseNpmPackageSpec(bad), null, `must reject spaced spec ${JSON.stringify(bad)}`);
  }
});

test('rejects malformed names and empty versions', () => {
  for (const bad of ['', '   ', '@scope', '@scope/', 'foo@', 'UPPER-Case', '.starts', '_lead', '-dash', '@SCOPE/name', 'foo@1.0.0@2.0.0']) {
    assert.equal(parseNpmPackageSpec(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('bounds input size', () => {
  assert.equal(parseNpmPackageSpec('a'.repeat(600)), null, 'oversized spec must not reach the network');
  assert.ok(parseNpmPackageSpec('a'.repeat(200) + '@1.0.0'), 'but a legit long spec is fine');
});
