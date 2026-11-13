'use strict';

// Properties-store P1 (plan: docs/plans/properties-store.md §1, §5) — the
// interface + driver factory. One PropertiesStore contract, implementations
// chosen by driver; callers (facade, HTTP, boot) never learn which backend
// they have (JSONB-always keeps every backend byte-identical in shape).
//
// Interface: get / put / delete / list / close.
//   - keys normalize on every call (keys.mjs), scopes validate (global
//     forces scope_id '' so the PK cannot split one global row across ids),
//   - `version` is optimistic concurrency: pass expectedVersion to make a
//     write conflict instead of clobbering (HTTP maps this to 409),
//   - soft delete stamps deleted_at and CLEARS the value — "cleared" and
//     "never set" stay different facts (get returns a row vs null),
//   - `secret: true` seals the value under the envelope columns; without key
//     material the write is refused (fail-closed, never plaintext fallback).

import { decodeEncryptionKey } from './envelope.mjs';

export const PROPERTY_SCOPES = Object.freeze([ 'global', 'account', 'session', 'plugin' ]);
export const PROPERTY_VALUE_MAX_BYTES = 64 * 1024;

export class PropertyStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PropertyStoreError';
    this.code = code;
  }
}

// The PK is (scope_type, scope_id, key): scope_id is PK-SAFE, so 'global'
// always maps to '' and a non-global scope without an id is refused here at
// the app layer (the DDL CHECK is the backstop, not the UX).
export function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope))
    throw new PropertyStoreError('property_scope_invalid', 'scope must be { type, id }');
  const type = typeof scope.type === 'string' ? scope.type : '';
  if (!PROPERTY_SCOPES.includes(type))
    throw new PropertyStoreError('property_scope_invalid',
      `unknown scope_type ${JSON.stringify(scope.type)} (want one of ${PROPERTY_SCOPES.join(', ')})`);
  if (type === 'global')
    return { type, id: '' };
  const id = typeof scope.id === 'string' ? scope.id.trim() : '';
  if (id === '')
    throw new PropertyStoreError('property_scope_invalid', `scope_type '${type}' requires a scope id`);
  return { type, id };
}

// Driver selection: explicit driver wins; otherwise a database URL means
// PostgreSQL and everything else lands on sqlite (file or :memory:). Unknown
// drivers are REFUSED, never guessed — same posture as the migrations
// driver list.
export async function openPropertiesStore(options = {}) {
  const driver = options.driver || (options.url ? 'postgresql' : 'sqlite');
  if (driver === 'sqlite') {
    const { openSQLitePropertiesStore } = await import('./store-sql.mjs');
    return openSQLitePropertiesStore(options);
  }
  if (driver === 'postgresql') {
    const { openPostgresqlPropertiesStore } = await import('./store-sql.mjs');
    return openPostgresqlPropertiesStore(options);
  }
  throw new PropertyStoreError('property_store_driver',
    `unknown properties driver ${JSON.stringify(driver)} (supported: sqlite, postgresql)`);
}

// Key material is decoded ONCE at the trust boundary (store open); an
// unusable or absent key leaves the store usable for plain rows while every
// secret read/write stays fail-closed. Returns { key, keyError }.
export function resolveStoreEncryptionKey(options, logger) {
  const raw = options.encryptionKey;
  if (raw === null || raw === undefined || raw === '')
    return { key: null, keyError: null };
  try {
    return { key: decodeEncryptionKey(raw), keyError: null };
  } catch (error) {
    logger?.warn?.(`[properties] unusable encryption key (${error.code}) — secret values stay fail-closed`);
    return { key: null, keyError: error };
  }
}
