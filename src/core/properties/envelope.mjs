'use strict';

// Properties-store P1 — value envelopes (plan: docs/plans/properties-store.md
// §1 schema). The envelope is self-describing AND must match its row columns:
// on open, `alg` must equal encryption_method and `kid` must equal key_ref, or
// we refuse (fail-closed) — column tampering cannot aim decryption anywhere the
// envelope does not independently confirm. The allowlist is aes-256-gcm only:
// algorithm agility is downgrade surface, same posture as
// signature_mode=required. Presence of `__enc` (or the row's envelope columns)
// IS the secret flag; there is no separate boolean.

import crypto from 'node:crypto';

export const ENVELOPE_ALGORITHM = 'aes-256-gcm';
export const ENVELOPE_ALGS = Object.freeze([ 'aes-256-gcm' ]);
export const ENVELOPE_VERSION = 1;
export const KEY_REF_PREFIX = 'properties-v1/';
export const ENCRYPTION_KEY_BYTES = 32;

export class PropertyEnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PropertyEnvelopeError';
    this.code = code;
  }
}

// Key material: 64 hex chars, or canonical base64 of exactly 32 bytes.
// Anything else is a format refusal — fail-closed, named loudly. A string is
// decoded once at the trust boundary (store open / seal) and never re-decoded.
export function decodeEncryptionKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0)
    throw new PropertyEnvelopeError('property_encryption_key_format',
      'encryption key must be a non-empty string (64 hex chars or base64 of 32 bytes)');
  if (/^[0-9a-fA-F]{64}$/.test(raw))
    return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  const canonical = decoded.toString('base64') === raw;
  if (decoded.length !== ENCRYPTION_KEY_BYTES || !canonical)
    throw new PropertyEnvelopeError('property_encryption_key_format',
      'encryption key must be 64 hex chars or canonical base64 of exactly 32 bytes');
  return decoded;
}

// key_ref = key name + fingerprint, never the key: 'properties-v1/<8 hex of
// the key's SHA-256>'. Stable per key, distinct across keys.
export function keyRefFor(keyBytes) {
  if (!Buffer.isBuffer(keyBytes))
    throw new PropertyEnvelopeError('property_encryption_key_format', 'keyRefFor expects decoded key bytes');
  const fingerprint = crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 8);
  return `${KEY_REF_PREFIX}${fingerprint}`;
}

function toKeyBytes(key, action) {
  if (key === null || key === undefined || key === '')
    throw new PropertyEnvelopeError('property_envelope_key',
      `cannot ${action} without key material (KIKX_PROPERTIES_ENCRYPTION_KEY) — fail-closed`);
  if (Buffer.isBuffer(key))
    return key;
  if (typeof key === 'string')
    return decodeEncryptionKey(key);
  throw new PropertyEnvelopeError('property_envelope_key', `cannot ${action}: unusable key material`);
}

export function isProtectedEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof value.__enc === 'object' && value.__enc !== null;
}

// Seal a value into a protected envelope. The plaintext is the JSONB-always
// wrapper `{"value": …}` so plain and protected rows are byte-identical in
// shape after open.
export function sealPropertiesValue(value, key) {
  const keyBytes = toKeyBytes(key, 'seal');
  const kid = keyRefFor(keyBytes);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENVELOPE_ALGORITHM, keyBytes, iv);
  const ct = Buffer.concat([ cipher.update(JSON.stringify({ value }), 'utf8'), cipher.final() ]);
  const tag = cipher.getAuthTag();
  return {
    __enc: {
      v: ENVELOPE_VERSION,
      alg: ENVELOPE_ALGORITHM,
      kid,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    },
  };
}

// Open a stored value. `alg`/`kid` are the ROW COLUMNS (encryption_method /
// key_ref); they must independently confirm what the envelope claims. Returns
// the plain wrapper `{ value }`, or refuses with a stable `.code`.
export function openPropertiesValue(envelope, { key = null, alg = null, kid = null } = {}) {
  if (!isProtectedEnvelope(envelope)) {
    // Plain value: legal only when the columns say plain. Anything else is
    // tampering (a sealed column with plaintext, or a non-envelope object).
    if (alg !== null || kid !== null || !envelope || typeof envelope !== 'object' || Array.isArray(envelope)
        || !('value' in envelope))
      throw new PropertyEnvelopeError('property_envelope_mismatch',
        'plain value does not match its envelope columns');
    return envelope;
  }

  const enc = envelope.__enc;
  if (enc.v !== ENVELOPE_VERSION)
    throw new PropertyEnvelopeError('property_envelope_version',
      `envelope version ${JSON.stringify(enc.v)} is not supported (want ${ENVELOPE_VERSION})`);
  if (!ENVELOPE_ALGS.includes(enc.alg))
    throw new PropertyEnvelopeError('property_envelope_alg',
      `algorithm ${JSON.stringify(enc.alg)} is not in the allowlist (${ENVELOPE_ALGS.join(', ')})`);
  if (alg === null || kid === null || enc.alg !== alg || enc.kid !== kid)
    throw new PropertyEnvelopeError('property_envelope_mismatch',
      'envelope alg/kid do not match the row columns — refusing to decrypt');

  const keyBytes = toKeyBytes(key, 'open');
  try {
    const decipher = crypto.createDecipheriv(enc.alg, keyBytes, Buffer.from(enc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
    const plain = Buffer.concat([ decipher.update(Buffer.from(enc.ct, 'base64')), decipher.final() ]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('value' in parsed))
      throw new PropertyEnvelopeError('property_envelope_open', 'decrypted payload is not an envelope wrapper');
    return parsed;
  } catch (error) {
    if (error instanceof PropertyEnvelopeError)
      throw error;
    throw new PropertyEnvelopeError('property_envelope_open',
      `decryption failed (${error?.code || error?.message || 'auth tag'}) — wrong key or tampered ciphertext`);
  }
}
