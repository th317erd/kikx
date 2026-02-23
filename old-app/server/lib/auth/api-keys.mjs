'use strict';

import { randomBytes, createHash } from 'crypto';
import { getDatabase } from '../../database.mjs';

const KEY_LENGTH  = 32;
const KEY_PREFIX  = 'hero_';

/**
 * Hash an API key for storage.
 *
 * @param {string} key - The plaintext API key
 * @returns {string} SHA-256 hash (hex)
 */
function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Create a new API key for a user.
 * Returns the plaintext key exactly once — it is not stored.
 *
 * @param {number} userId - The user ID
 * @param {string} name - Human-readable name for the key
 * @param {object} [options] - Optional settings
 * @param {string[]} [options.scopes] - Permission scopes (default: all)
 * @param {string} [options.expiresAt] - ISO date string for expiry (null = never)
 * @param {object} [database] - Optional database instance (for testing)
 * @returns {{id: number, key: string, keyPrefix: string, name: string, scopes: string[], expiresAt: string|null}}
 */
export function createApiKey(userId, name, options = {}, database) {
  let db = database || getDatabase();

  if (!name || typeof name !== 'string' || name.trim().length === 0)
    throw new Error('API key name is required');

  let scopes    = options.scopes || [];
  let expiresAt = options.expiresAt || null;

  // Generate the plaintext key
  let rawKey    = randomBytes(KEY_LENGTH).toString('hex');
  let plaintext = `${KEY_PREFIX}${rawKey}`;
  let keyHash   = hashKey(plaintext);
  let keyPrefix = plaintext.substring(0, KEY_PREFIX.length + 8); // hero_XXXXXXXX

  let result = db.prepare(`
    INSERT INTO api_keys (key_hash, key_prefix, user_id, name, scopes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(keyHash, keyPrefix, userId, name.trim(), JSON.stringify(scopes), expiresAt);

  return {
    id:        Number(result.lastInsertRowid),
    key:       plaintext,
    keyPrefix: keyPrefix,
    name:      name.trim(),
    scopes:    scopes,
    expiresAt: expiresAt,
  };
}

/**
 * List all API keys for a user. Does NOT include plaintext keys.
 *
 * @param {number} userId - The user ID
 * @param {object} [database] - Optional database instance (for testing)
 * @returns {Array<{id: number, keyPrefix: string, name: string, scopes: string[], expiresAt: string|null, lastUsedAt: string|null, createdAt: string}>}
 */
export function listApiKeys(userId, database) {
  let db   = database || getDatabase();
  let rows = db.prepare(`
    SELECT id, key_prefix, name, scopes, expires_at, last_used_at, created_at
    FROM api_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);

  return rows.map((row) => ({
    id:         row.id,
    keyPrefix:  row.key_prefix,
    name:       row.name,
    scopes:     JSON.parse(row.scopes || '[]'),
    expiresAt:  row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt:  row.created_at,
  }));
}

/**
 * Revoke (delete) an API key.
 *
 * @param {number} userId - The user ID (for ownership check)
 * @param {number} keyId - The API key ID
 * @param {object} [database] - Optional database instance (for testing)
 * @returns {boolean} True if the key was deleted
 */
export function revokeApiKey(userId, keyId, database) {
  let db     = database || getDatabase();
  let result = db.prepare(`
    DELETE FROM api_keys
    WHERE id = ? AND user_id = ?
  `).run(keyId, userId);

  return result.changes > 0;
}

/**
 * Validate an API key string and return the associated user.
 * Updates last_used_at on success.
 *
 * @param {string} key - The plaintext API key
 * @param {object} [database] - Optional database instance (for testing)
 * @returns {{userId: number, name: string, scopes: string[]} | null} Key info or null if invalid
 */
export function validateApiKey(key, database) {
  let db = database || getDatabase();

  if (!key || typeof key !== 'string' || !key.startsWith(KEY_PREFIX))
    return null;

  let keyHash = hashKey(key);
  let record  = db.prepare(`
    SELECT id, user_id, name, scopes, expires_at
    FROM api_keys
    WHERE key_hash = ?
  `).get(keyHash);

  if (!record)
    return null;

  // Check expiry
  if (record.expires_at && new Date(record.expires_at) < new Date())
    return null;

  // Update last_used_at
  db.prepare(`
    UPDATE api_keys
    SET last_used_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(record.id);

  return {
    userId: record.user_id,
    name:   record.name,
    scopes: JSON.parse(record.scopes || '[]'),
  };
}

export default {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,
};
