'use strict';

// Driver-agnostic text primitives shared by every search/query/range path.
// Kept in one place so PostgreSQL, SQLite (scan fallback) and any future driver
// agree on hashing, byte counting and numeric clamping. Nothing here imports a
// database client.

import { createHash } from 'node:crypto';

export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

// Stable content hash for stale-write guards; changes whenever the stored body
// changes. SHA-256 keeps collision risk irrelevant for the guard's purpose.
export function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
