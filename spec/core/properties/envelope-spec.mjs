'use strict';

import '../../support/test-env.mjs';

// Properties-store P1 (plan: docs/plans/properties-store.md, §1 schema).
// The envelope is self-describing AND must match its row columns: on open,
// `alg` must equal encryption_method and `kid` must equal key_ref, or we
// refuse (fail-closed) — column tampering cannot aim decryption anywhere the
// envelope does not independently confirm. The algorithm allowlist is
// aes-256-gcm only: agility is downgrade surface. Presence of the envelope
// columns IS the secret flag; no separate boolean exists.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENVELOPE_ALGS,
  ENVELOPE_ALGORITHM,
  KEY_REF_PREFIX,
  decodeEncryptionKey,
  keyRefFor,
  sealPropertiesValue,
  openPropertiesValue,
  isProtectedEnvelope,
} from '../../../src/core/properties/envelope.mjs';

const HEX_KEY_A = 'a'.repeat(64);
const HEX_KEY_B = 'b'.repeat(64);
// base64 of 32 zero bytes (44 chars, standard padding).
const B64_KEY_ZEROS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function expectCode(fn, code, why) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, `${why}: refusal must be an Error`);
    assert.equal(error.code, code,
      `${why}: expected code ${code}, got ${error.code} (${error.message})`);
    return true;
  }, why);
}

test('the allowlist is exactly aes-256-gcm — agility is downgrade surface', () => {
  assert.deepEqual(Object.freeze([ ...ENVELOPE_ALGS ]), [ 'aes-256-gcm' ]);
  assert.equal(ENVELOPE_ALGORITHM, 'aes-256-gcm');
  assert.ok(ENVELOPE_ALGS.includes(ENVELOPE_ALGORITHM));
});

test('key decoding: 64-hex or base64 of >=32 bytes, anything else refused', () => {
  const fromHex = decodeEncryptionKey(HEX_KEY_A);
  assert.ok(Buffer.isBuffer(fromHex));
  assert.equal(fromHex.length, 32);
  assert.equal(decodeEncryptionKey(HEX_KEY_A.toUpperCase()).toString('hex'), fromHex.toString('hex'),
    'hex is case-insensitive');
  const fromB64 = decodeEncryptionKey(B64_KEY_ZEROS);
  assert.equal(fromB64.length, 32);
  assert.deepEqual([ ...fromB64 ], [ ...Buffer.alloc(32) ], 'known zero-bytes vector');
  for (const bad of [ '', 'short', '!@#$', 'g'.repeat(4), 'a'.repeat(20), 'xyz!' ]) {
    expectCode(() => decodeEncryptionKey(bad), 'property_encryption_key_format',
      `key ${JSON.stringify(bad)} must be refused`);
  }
});

test('key refs follow properties-v1/<8 hex>, are stable, and key-scoped', () => {
  const refA = keyRefFor(decodeEncryptionKey(HEX_KEY_A));
  assert.match(refA, /^properties-v1\/[0-9a-f]{8}$/);
  assert.ok(refA.startsWith(KEY_REF_PREFIX));
  assert.equal(keyRefFor(decodeEncryptionKey(HEX_KEY_A)), refA, 'stable for the same key');
  assert.notEqual(keyRefFor(decodeEncryptionKey(HEX_KEY_B)), refA, 'distinct per key');
});

test('seal/open round-trips every JSON shape byte-identically (JSONB-always)', () => {
  const key = decodeEncryptionKey(HEX_KEY_A);
  const kid = keyRefFor(key);
  const values = [
    { theme: 'purple' },
    'plain string',
    42,
    null,
    [ 1, 'two', { three: true } ],
    { nested: { deep: { arr: [ null, 1 ] } } },
  ];
  for (const value of values) {
    const envelope = sealPropertiesValue(value, key);
    assert.ok(isProtectedEnvelope(envelope), 'sealed values carry __enc');
    assert.equal(envelope.__enc.v, 1);
    assert.equal(envelope.__enc.alg, ENVELOPE_ALGORITHM);
    assert.equal(envelope.__enc.kid, kid, 'envelope kid matches the key that sealed it');
    assert.equal(typeof envelope.__enc.iv, 'string');
    assert.equal(typeof envelope.__enc.tag, 'string');
    assert.equal(typeof envelope.__enc.ct, 'string');
    const opened = openPropertiesValue(envelope, { key, alg: ENVELOPE_ALGORITHM, kid });
    assert.deepEqual(opened, { value }, `round-trip of ${JSON.stringify(value)}`);
  }
});

test('plain envelopes pass through only when the columns say plain', () => {
  const key = decodeEncryptionKey(HEX_KEY_A);
  assert.equal(isProtectedEnvelope({ value: 'x' }), false);
  assert.deepEqual(openPropertiesValue({ value: 'x' }, { key, alg: null, kid: null }), { value: 'x' });
  // A plain value under sealed columns is tampering: refuse.
  expectCode(
    () => openPropertiesValue({ value: 'x' }, { key, alg: ENVELOPE_ALGORITHM, kid: 'properties-v1/00000000' }),
    'property_envelope_mismatch',
    'plain value with sealed columns',
  );
  // A sealed envelope under plain columns is tampering too.
  const sealed = sealPropertiesValue('x', key);
  expectCode(
    () => openPropertiesValue(sealed, { key, alg: null, kid: null }),
    'property_envelope_mismatch',
    'sealed value with plain columns',
  );
});

test('alg must be allowlisted and must equal the column', () => {
  const key = decodeEncryptionKey(HEX_KEY_A);
  const kid = keyRefFor(key);
  const forged = { __enc: { v: 1, alg: 'rot13', kid, iv: 'AA', tag: 'BB', ct: 'CC' } };
  expectCode(
    () => openPropertiesValue(forged, { key, alg: 'rot13', kid }),
    'property_envelope_alg',
    'alg outside the allowlist is refused even when the columns agree',
  );
  const sealed = sealPropertiesValue('secret', key);
  expectCode(
    () => openPropertiesValue(sealed, { key, alg: 'aes-192-gcm', kid }),
    'property_envelope_mismatch',
    'known-shape but wrong column alg',
  );
});

test('kid must equal the column key_ref — tampering cannot re-aim the key', () => {
  const key = decodeEncryptionKey(HEX_KEY_A);
  const sealed = sealPropertiesValue('secret', key);
  expectCode(
    () => openPropertiesValue(sealed, { key, alg: ENVELOPE_ALGORITHM, kid: 'properties-v1/deadbeef' }),
    'property_envelope_mismatch',
    'kid/column disagreement',
  );
});

test('unknown envelope version is refused (no silent forward-compat)', () => {
  const key = decodeEncryptionKey(HEX_KEY_A);
  const kid = keyRefFor(key);
  const future = { __enc: { v: 2, alg: ENVELOPE_ALGORITHM, kid, iv: 'AA', tag: 'BB', ct: 'CC' } };
  expectCode(
    () => openPropertiesValue(future, { key, alg: ENVELOPE_ALGORITHM, kid }),
    'property_envelope_version',
    'v:2',
  );
});

test('opening without key material is fail-closed', () => {
  const key = decodeEncryptionKey(HEX_KEY_A);
  const sealed = sealPropertiesValue('secret', key);
  for (const missing of [ null, undefined ]) {
    expectCode(
      () => openPropertiesValue(sealed, { key: missing, alg: ENVELOPE_ALGORITHM, kid: keyRefFor(key) }),
      'property_envelope_key',
      'no key, no plaintext',
    );
  }
});

test('sealing without key material is refused (secret-write-without-key)', () => {
  expectCode(() => sealPropertiesValue('secret', null), 'property_envelope_key', 'seal with no key');
  expectCode(() => sealPropertiesValue('secret', undefined), 'property_envelope_key', 'seal with no key');
});

test('ciphertext tampering fails the GCM tag and refuses', () => {
  const key = decodeEncryptionKey(HEX_KEY_A);
  const kid = keyRefFor(key);
  const sealed = sealPropertiesValue({ password: 'hunter2' }, key);
  const ct = Buffer.from(sealed.__enc.ct, 'base64');
  ct[0] ^= 0xff;
  const tampered = { __enc: { ...sealed.__enc, ct: ct.toString('base64') } };
  expectCode(
    () => openPropertiesValue(tampered, { key, alg: ENVELOPE_ALGORITHM, kid }),
    'property_envelope_open',
    'bit-flipped ciphertext',
  );
});
