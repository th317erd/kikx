'use strict';

// Small shared primitives for the PostgreSQL search/query/range helpers. Kept
// in one place so the search, locator, and range modules agree on hashing,
// byte counting, numeric clamping, and typed error construction.

import { createHash } from 'node:crypto';

import { DatabaseError } from './database-error.mjs';

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

export function invalidQuery(message) {
  return new DatabaseError(message, { status: 400, code: 'invalid_query' });
}

export function invalidRange(message) {
  return new DatabaseError(message, { status: 400, code: 'invalid_range' });
}

export function staleDocument(message) {
  return new DatabaseError(message, { status: 409, code: 'conflict' });
}
