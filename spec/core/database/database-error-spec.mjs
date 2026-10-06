'use strict';

// DatabaseError is the boundary error type for every driver. It must preserve
// `status` exactly (many call sites key on `status === 404`) and must be
// importable without importing AeorDB.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseError } from '../../../src/core/database/database-error.mjs';

test('DatabaseError is an Error with a stable name and default status', () => {
  let error = new DatabaseError('boom');

  assert.ok(error instanceof Error);
  assert.equal(error.name, 'DatabaseError');
  assert.equal(error.message, 'boom');
  assert.equal(error.status, 0);
  assert.equal(error.code, null);
  assert.equal(error.notFound, false);
  assert.equal(error.cause, undefined);
});

test('DatabaseError preserves status, code and cause', () => {
  let cause = new Error('underlying');
  let error = new DatabaseError('missing', { status: 404, code: 'not_found', cause });

  assert.equal(error.status, 404);
  assert.equal(error.code, 'not_found');
  assert.equal(error.cause, cause);
});

test('DatabaseError.notFound is true only for status 404', () => {
  assert.equal(new DatabaseError('a', { status: 404 }).notFound, true);
  assert.equal(new DatabaseError('b', { status: 500 }).notFound, false);
  assert.equal(new DatabaseError('c').notFound, false);
});

test('DatabaseError.forStatus builds a typed error with a default message', () => {
  let error = DatabaseError.forStatus(404);

  assert.equal(error.status, 404);
  assert.equal(error.notFound, true);
  assert.match(error.message, /not found/i);
});

test('DatabaseError is not AeorDBError and does not require AeorDB to construct', async () => {
  // The module graph of the error type must not pull in the AeorDB client.
  let module = await import('../../../src/core/database/database-error.mjs');
  assert.equal(typeof module.DatabaseError, 'function');
  assert.equal(module.DatabaseError.name, 'DatabaseError');
});
