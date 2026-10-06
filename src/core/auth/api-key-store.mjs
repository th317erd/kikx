'use strict';

import {
  formatToken,
  generateId,
  generateSecret,
  hashSecret,
  parseToken,
  secretsEqual,
} from './token-utils.mjs';

// API keys reuse the opaque `<id>.<secret>` shape. Only the secret hash is
// stored; `prefix` (the first 8 characters of the id) is safe to display so a
// user can tell keys apart without revealing the secret.
const API_KEYS_ROOT = '/kikx/auth/api-keys';

export function createApiKeyStore({ db, clock = Date.now } = {}) {
  if (!db)
    throw new TypeError('createApiKeyStore requires db');

  // Returns `{ key, apiKey }`: `key` is the redacted stored record and `apiKey`
  // is the full opaque key, which is returned exactly once. The raw record
  // (including `secretHash`) never crosses this boundary.
  async function create({ userId, label = '' } = {}) {
    let id = generateId();
    let secret = generateSecret();
    let now = clock();
    let key = {
      type: 'api-key',
      id,
      userId,
      label: normalizeOptionalString(label),
      prefix: id.slice(0, 8),
      secretHash: hashSecret(secret),
      createdAt: now,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    };

    await db.put(apiKeyPath(id), key);

    return { key: publicKey(key), apiKey: formatToken(id, secret) };
  }

  // Owner-disabled and owner-missing checks belong to the AuthService layer:
  // this store deliberately has no user dependency. On a successful match the
  // record's lastUsedAt is refreshed.
  async function verify(apiKey) {
    let parsed = parseToken(apiKey);
    if (!parsed)
      return null;

    let key = await readKey(parsed.id);
    if (!key || key.revokedAt != null)
      return null;

    if (key.expiresAt != null && !(key.expiresAt > clock()))
      return null;

    if (!secretsEqual(key.secretHash, hashSecret(parsed.secret)))
      return null;

    await db.put(apiKeyPath(key.id), { ...key, lastUsedAt: clock() });
    return key.userId;
  }

  async function list(userId) {
    let { items } = await db.list(API_KEYS_ROOT, { recursive: true });
    let keys = [];
    for (let item of items) {
      let key = await db.get(item.path);
      if (key?.type === 'api-key' && key.userId === userId)
        keys.push(publicKey(key));
    }

    return keys;
  }

  async function revoke(userId, keyId) {
    let key = await readKey(keyId);
    if (!key || key.userId !== userId || key.revokedAt != null)
      return false;

    await db.put(apiKeyPath(keyId), { ...key, revokedAt: clock() });
    return true;
  }

  async function readKey(id) {
    if (typeof id !== 'string' || id === '')
      return null;

    let record = await db.get(apiKeyPath(id));
    return record && record.type === 'api-key' ? record : null;
  }

  return { create, verify, list, revoke };
}

// Strip the secret hash before a key crosses a trust boundary.
function publicKey(key) {
  return {
    id: key.id,
    userId: key.userId,
    label: key.label,
    prefix: key.prefix,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  };
}

function apiKeyPath(id) {
  return `${API_KEYS_ROOT}/${id}.json`;
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
