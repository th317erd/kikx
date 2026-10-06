'use strict';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Opaque-token primitives. A token is `<tokenId>.<secret>`: the id is public and
// used for O(1) document lookup, the secret is shown once and only its sha256
// is stored. Keeping every token-shaped concern in this module means a future
// JWT implementation can replace it without touching the stores.
export const TOKEN_ID_PATTERN = /^[0-9a-f]{32}$/;

export function generateId() {
  return randomBytes(16).toString('hex');
}

export function generateSecret() {
  // 32 random bytes base64url-encoded; Node omits the trailing '=' so this is
  // 43 characters.
  return randomBytes(32).toString('base64url');
}

export function formatToken(id, secret) {
  return `${id}.${secret}`;
}

// Split on the FIRST '.' so a secret containing dots still round-trips. The id
// must match the fixed hex shape and the secret must be non-empty.
export function parseToken(token) {
  if (typeof token !== 'string')
    return null;

  let separator = token.indexOf('.');
  if (separator < 0)
    return null;

  let id = token.slice(0, separator);
  let secret = token.slice(separator + 1);
  if (!TOKEN_ID_PATTERN.test(id) || secret.length === 0)
    return null;

  return { id, secret };
}

export function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

// Constant-time comparison of two secret hashes. A length mismatch returns
// false immediately (timingSafeEqual throws on unequal buffer lengths).
export function secretsEqual(hashA, hashB) {
  if (typeof hashA !== 'string' || typeof hashB !== 'string')
    return false;

  let left = Buffer.from(hashA, 'utf8');
  let right = Buffer.from(hashB, 'utf8');
  if (left.length !== right.length)
    return false;

  return timingSafeEqual(left, right);
}
