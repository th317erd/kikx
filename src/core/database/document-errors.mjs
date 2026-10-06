'use strict';

// Shared typed-error constructors for the document search/range surfaces. Every
// driver returns the same DatabaseError codes so callers can branch on
// `status`/`code` without knowing which backend answered.

import { DatabaseError } from './database-error.mjs';

export function invalidQuery(message) {
  return new DatabaseError(message, { status: 400, code: 'invalid_query' });
}

export function invalidRange(message) {
  return new DatabaseError(message, { status: 400, code: 'invalid_range' });
}

export function staleDocument(message) {
  return new DatabaseError(message, { status: 409, code: 'conflict' });
}
