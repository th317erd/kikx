'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOKEN_ID_PATTERN,
  formatToken,
  generateId,
  generateSecret,
  hashSecret,
  parseToken,
  secretsEqual,
} from '../../../src/core/auth/token-utils.mjs';

test('generateId produces a 32-character lowercase hex id matching the pattern', () => {
  for (let index = 0; index < 25; index++) {
    let id = generateId();
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(TOKEN_ID_PATTERN.test(id));
  }
});

test('generateSecret produces a 43-character unpadded base64url secret', () => {
  for (let index = 0; index < 25; index++) {
    let secret = generateSecret();
    assert.equal(secret.length, 43);
    assert.match(secret, /^[A-Za-z0-9_-]+$/);
  }

  assert.notEqual(generateSecret(), generateSecret());
});

test('formatToken and parseToken round-trip the id and secret', () => {
  let id = generateId();
  let secret = generateSecret();
  let token = formatToken(id, secret);
  assert.equal(token, `${id}.${secret}`);
  assert.deepEqual(parseToken(token), { id, secret });
});

test('parseToken splits on the first dot so secrets may contain dots', () => {
  let id = generateId();
  let parsed = parseToken(`${id}.secret.with.dots`);
  assert.deepEqual(parsed, { id, secret: 'secret.with.dots' });
});

test('parseToken rejects malformed tokens', () => {
  let validId = generateId();
  let malformed = [
    undefined,
    null,
    '',
    'no-dot-at-all',
    `.${generateSecret()}`,
    `${validId}.`,
    `${validId.toUpperCase()}.${generateSecret()}`,
    `zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.${generateSecret()}`,
    `${validId.slice(0, 31)}.${generateSecret()}`,
    `${validId}0.${generateSecret()}`,
  ];

  for (let token of malformed) {
    assert.equal(parseToken(token), null, `expected null for ${JSON.stringify(token)}`);
  }
});

test('hashSecret is stable and matches a known sha256 digest', () => {
  assert.equal(hashSecret('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hashSecret('abc'), hashSecret('abc'));
  assert.notEqual(hashSecret('abc'), hashSecret('abd'));
  assert.equal(hashSecret('abc').length, 64);
});

test('secretsEqual compares equal hashes and rejects every mismatch', () => {
  let hash = hashSecret('correct horse battery staple');
  assert.equal(secretsEqual(hash, hash), true);
  assert.equal(secretsEqual(hash, hashSecret('different')), false);
  assert.equal(secretsEqual(hash, hash.slice(0, -1)), false);
  assert.equal(secretsEqual(hash, null), false);
  assert.equal(secretsEqual(null, hash), false);
  assert.equal(secretsEqual(undefined, undefined), false);
  assert.equal(secretsEqual('', ''), true);
});
