'use strict';

import '../../support/test-env.mjs';

// Properties-store P1 (plan: docs/plans/properties-store.md, §1 key model).
// Every write normalizes: ` /a/b`, `/a/b` and `/a//b` must never be three
// keys, `..` never traverses, empty/control segments never round-trip, and
// length is bounded (256). These rules are pinned HERE first; keys.mjs must
// satisfy them. `.` segments are refused with `..`: the plan names `..`, but
// silently rewriting `.` is the same ambiguity class — never rewrite hostile
// input, refuse it.
//
// Hostile characters are built with String.fromCharCode so this source file
// stays plain ASCII (a raw NUL/newline inside a string literal once broke it).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePropertyKey,
  normalizePropertyPrefix,
  isAbsolutePropertyKey,
  PROPERTY_KEY_MAX_LENGTH,
  PropertyKeyError,
} from '../../../src/core/properties/keys.mjs';

const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

function refuse(key, why) {
  assert.throws(
    () => normalizePropertyKey(key),
    (error) => {
      assert.ok(error instanceof Error, `refusal for ${JSON.stringify(key)} must be an Error`);
      assert.ok(error instanceof PropertyKeyError,
        `refusal for ${JSON.stringify(key)} must be a PropertyKeyError`);
      assert.equal(error.code, 'property_key_invalid',
        `refusal for ${JSON.stringify(key)} must carry property_key_invalid`);
      return true;
    },
    `expected refusal: ${why} (got ${JSON.stringify(key)})`,
  );
}

function refusePrefix(prefix, why) {
  assert.throws(
    () => normalizePropertyPrefix(prefix),
    (error) => {
      assert.ok(error instanceof PropertyKeyError, `prefix refusal for ${JSON.stringify(prefix)} must be a PropertyKeyError`);
      assert.equal(error.code, 'property_key_invalid');
      return true;
    },
    `expected prefix refusal: ${why} (got ${JSON.stringify(prefix)})`,
  );
}

// Post-normalization invariants, applied to every value normalize returns.
function assertInvariants(input, out) {
  assert.equal(typeof out, 'string', `normalize(${JSON.stringify(input)}) must return a string`);
  assert.ok(out.length > 0, `normalize(${JSON.stringify(input)}) must not be empty`);
  assert.ok(out.length <= PROPERTY_KEY_MAX_LENGTH, `normalize(${JSON.stringify(input)}) exceeds the bound`);
  assert.equal(out, out.toLowerCase(), `normalize must be lowercase: ${JSON.stringify(out)}`);
  assert.equal(out, out.trim(), `normalize must be trimmed: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('//'), `normalize must collapse //: ${JSON.stringify(out)}`);
  assert.equal(out.indexOf(NUL), -1, `normalize must carry no NUL: ${JSON.stringify(out)}`);
  assert.equal(out.indexOf(NEWLINE), -1, `normalize must carry no newline: ${JSON.stringify(out)}`);
  assert.equal(out.indexOf(RTL_OVERRIDE), -1, `normalize must carry no bidi override: ${JSON.stringify(out)}`);
  const segments = out.split('/');
  const body = out.startsWith('/') ? segments.slice(1) : segments;
  for (const segment of body) {
    assert.ok(segment.length > 0, `normalize left an empty segment: ${JSON.stringify(out)}`);
    assert.notEqual(segment, '.', `normalize left a dot segment: ${JSON.stringify(out)}`);
    assert.notEqual(segment, '..', `normalize left a traversal segment: ${JSON.stringify(out)}`);
    assert.equal(segment, segment.trim(), `normalize left untrimmed segment: ${JSON.stringify(out)}`);
  }
}

test('the canonical trio collapses to exactly one key (plan verbatim)', () => {
  const a = normalizePropertyKey(' /a/b');
  const b = normalizePropertyKey('/a/b');
  const c = normalizePropertyKey('/a//b');
  assert.equal(a, '/a/b');
  assert.equal(b, '/a/b');
  assert.equal(c, '/a/b');
  assert.deepEqual(new Set([ a, b, c ]).size, 1, 'the three spellings must be one key');
});

test('keys are trimmed, lowercased, and relative keys stay relative', () => {
  assert.equal(normalizePropertyKey('  /Core/Kikx/Email  '), '/core/kikx/email');
  assert.equal(normalizePropertyKey('  CustomPlugin_Value '), 'customplugin_value');
  // Segment-level trim: padding around a segment disappears with it.
  assert.equal(normalizePropertyKey('/a/ b/c'), '/a/b/c');
  // Internal spaces inside a segment survive (they are content, not padding).
  assert.equal(normalizePropertyKey('  /a b  '), '/a b');
  // Unicode folds by the platform's lowercase, and that is fine.
  assert.equal(normalizePropertyKey('/Ä/Ö'), '/ä/ö');
});

test('traversal and dot segments are refused, never rewritten', () => {
  refuse('/a/../b', 'traversal in the middle');
  refuse('../x', 'leading traversal');
  refuse('/..', 'bare traversal segment');
  refuse('..', 'only a traversal');
  refuse('/a/../../etc/passwd', 'classic escape');
  refuse('/a/./b', 'dot segment (same class as ..)');
  refuse('./x', 'leading dot segment');
  refuse('.', 'only a dot');
});

test('empty, whitespace-only, root-only, and trailing-slash keys are refused', () => {
  refuse('', 'empty');
  refuse('   ', 'whitespace only');
  refuse('/', 'root has no key under it');
  refuse('//', 'root after collapse');
  refuse('/a/b/', 'trailing slash leaves an empty segment');
  refuse('/a/b//', 'trailing // still leaves an empty segment');
  refuse('/a/ /b', 'whitespace-only segment trims to empty');
  refuse('/a//b/c//', 'multiple empty segments');
});

test('length is bounded: 256 accepted, 257 refused', () => {
  const atBound = `/${'a'.repeat(PROPERTY_KEY_MAX_LENGTH - 1)}`;
  assert.equal(atBound.length, PROPERTY_KEY_MAX_LENGTH);
  assert.equal(normalizePropertyKey(atBound), atBound.toLowerCase());
  const overBound = `/${'a'.repeat(PROPERTY_KEY_MAX_LENGTH)}`;
  refuse(overBound, 'one past the bound');
  refuse(`/${'a'.repeat(10000)}`, 'absurdly long');
});

test('control characters are refused anywhere in the key', () => {
  refuse(`/a${NUL}b`, 'NUL inside a segment');
  refuse(`/a${NEWLINE}b`, 'newline inside a segment');
  refuse(`/a${RTL_OVERRIDE}b`, 'RTL override (format char)');
  // Trim happens first: tab-padding is whitespace like any other.
  assert.equal(normalizePropertyKey(`${TAB}/a`), '/a');
});

test('non-string inputs are refused as Errors with the stable code', () => {
  for (const input of [ null, undefined, 42, 0, true, {}, [], Symbol.iterator, 12n ]) {
    let value;
    try {
      value = normalizePropertyKey(input);
    } catch (error) {
      assert.ok(error instanceof PropertyKeyError, `input ${String(input)} must raise PropertyKeyError`);
      assert.equal(error.code, 'property_key_invalid');
      continue;
    }
    assert.fail(`input ${String(input)} must be refused, got ${JSON.stringify(value)}`);
  }
});

test('isAbsolutePropertyKey distinguishes the two key forms without throwing', () => {
  assert.equal(isAbsolutePropertyKey('/core/x'), true);
  assert.equal(isAbsolutePropertyKey('relative_key'), false);
  assert.equal(isAbsolutePropertyKey(''), false);
  assert.equal(isAbsolutePropertyKey(null), false);
  assert.equal(isAbsolutePropertyKey(42), false);
});

test('prefix normalization: trailing slash legal, everything else folds like keys', () => {
  // list(scope, '/core') and list(scope, '/core/') are the same subtree, so
  // a trailing slash is NOT an empty segment here — unlike a stored key.
  assert.equal(normalizePropertyPrefix('/Core/'), '/core/');
  assert.equal(normalizePropertyPrefix('/core'), '/core');
  assert.equal(normalizePropertyPrefix('  /Core//Email  '), '/core/email');
  assert.equal(normalizePropertyPrefix('Custom/'), 'custom/');
  assert.equal(normalizePropertyPrefix(''), '', 'empty prefix = no filter');
  assert.equal(normalizePropertyPrefix('/'), '/', 'root prefix = whole scope');
  // The traversal/control/length refusals all still apply.
  refusePrefix('/a/../', 'traversal in a prefix');
  refusePrefix('..', 'traversal-only prefix');
  refusePrefix('/a/ /b/', 'empty segment before the trailing slash');
  refusePrefix(`/a${NUL}/`, 'control char in a prefix');
  assert.equal(
    normalizePropertyPrefix(`/${'a'.repeat(200)}/`),
    `/${'a'.repeat(200)}/`,
    'long-but-legal prefixes pass',
  );
  assert.throws(
    () => normalizePropertyPrefix(`/${'a'.repeat(PROPERTY_KEY_MAX_LENGTH)}`),
    (error) => error.code === 'property_key_invalid',
    'over-bound prefix refused',
  );
});

test('hostile-string sweep: whatever normalize returns is safe, or it refuses', () => {
  const HOSTILE = [
    '..%2f', '%2e%2e', '....//..', '/a/../../../etc/passwd', '\\', '/a\\b',
    `/${'\uD83D'}${'\uDC4D'}/${'\uD83C'}${'\uDFA8'}`, '{"a":1}', '/a/b?x=1', '/a/b#frag',
    'a'.repeat(5000), '/A/B/C', '///', ' / ', `/${RTL_OVERRIDE}`, '..',
    './', '/./', 'null', 'undefined', '/café/', '/%00', '/a/b ', 'x'.repeat(256),
  ];
  for (const input of HOSTILE) {
    let out;
    try {
      out = normalizePropertyKey(input);
    } catch (error) {
      assert.ok(error instanceof PropertyKeyError,
        `sweep ${JSON.stringify(input)} must raise PropertyKeyError, got ${error?.constructor?.name}`);
      assert.equal(error.code, 'property_key_invalid');
      continue;
    }
    assertInvariants(input, out);
  }
});
