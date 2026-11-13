'use strict';

import '../../support/test-env.mjs';

// Properties-store P6 (plan §4): DECLARED own-key schemas are validated
// server-side — that was the gate the static manifest was always protecting
// (validation + bounds), which the dynamic-properties relaxation kept while
// undeclared keys stay free. Schemas live under `properties` in the SAME
// signed manifest.json the access block comes from; malformed refuses at
// load, never half-registers.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_SCHEMA_TYPES,
  normalizeDeclaredSchemas,
  validateDeclaredValue,
} from '../../../src/core/properties/schemas.mjs';

function expectRefusal(fn, why) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, `${why}: must throw an Error`);
    assert.equal(error.code, 'property_schema_invalid',
      `${why}: expected property_schema_invalid, got ${error.code}`);
    return true;
  }, why);
}

test('the type vocabulary is pinned', () => {
  assert.deepEqual([ ...ALLOWED_SCHEMA_TYPES ], [ 'string', 'number', 'boolean', 'object', 'array', 'null' ]);
});

test('declared keys normalize like property keys; absolute/traversal/malformed refuse', () => {
  const schemas = normalizeDeclaredSchemas({
    last_run: { type: 'number' },
    '  My_Label ': { type: 'string', default: 'hi' },
  });
  assert.deepEqual(Object.keys(schemas).sort(), [ 'last_run', 'my_label' ]);
  assert.deepEqual(schemas.last_run, { type: 'number' });
  assert.deepEqual(schemas.my_label, { type: 'string', default: 'hi' }, 'default survives verbatim');
  assert.deepEqual(normalizeDeclaredSchemas(null), {}, 'an absent block is an empty declaration');
  assert.deepEqual(normalizeDeclaredSchemas({}), {});

  for (const [ block, why ] of [
    [ 'nope', 'properties must be an object' ],
    [ [ 'type' ], 'arrays are not maps' ],
    [ { '/core/absolute': { type: 'number' } }, 'absolute keys belong in access, not properties' ],
    [ { '../escape': { type: 'number' } }, 'traversal key' ],
    [ { ok: 'not-an-object' }, 'schema must be an object' ],
    [ { ok: {} }, 'schema requires a type' ],
    [ { ok: { type: 'float' } }, 'unknown type' ],
    [ { ok: { type: 'number', minimum: 0 } }, 'unknown schema field (no silent semantics)' ],
    [ { Last_Run: { type: 'number' }, last_run: { type: 'string' } }, 'normalized collision' ],
  ]) {
    expectRefusal(() => normalizeDeclaredSchemas(block), why);
  }
});

test('validateDeclaredValue: exact type discipline for every allowed type', () => {
  const check = (type, value) => validateDeclaredValue({ type }, value, 'some_key');
  assert.equal(check('number', 0), true);
  assert.equal(check('number', -1.5), true);
  expectRefusal(() => check('number', '1'), 'string is not a number');
  expectRefusal(() => check('number', NaN), 'NaN refuses');
  expectRefusal(() => check('number', Infinity), 'Infinity refuses');
  assert.equal(check('string', ''), true);
  expectRefusal(() => check('string', 7), 'number is not a string');
  assert.equal(check('boolean', false), true);
  expectRefusal(() => check('boolean', 'true'), 'string is not a boolean');
  assert.equal(check('object', { a: 1 }), true);
  expectRefusal(() => check('object', []), 'array is not object');
  expectRefusal(() => check('object', null), 'null is not object');
  assert.equal(check('array', [ 1, 2 ]), true);
  expectRefusal(() => check('array', {}), 'object is not array');
  assert.equal(check('null', null), true);
  expectRefusal(() => check('null', 0), '0 is not null');
});

test('refusal messages name the key and the expectation (operator-actionable)', () => {
  assert.throws(
    () => validateDeclaredValue({ type: 'number' }, 'seven', 'last_run'),
    (error) => {
      assert.equal(error.code, 'property_schema_invalid');
      assert.match(error.message, /last_run/, 'names the key');
      assert.match(error.message, /number/, 'names the expected type');
      return true;
    },
  );
});
