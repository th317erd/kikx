'use strict';

import { randomBytes } from 'crypto';
import { getDatabase } from '../../database.mjs';

const TOKEN_LENGTH    = 32;
const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Generate a magic link token for an email address.
 * If a user exists with that email, links to them. Otherwise, user_id is NULL.
 *
 * @param {string} email - Email address to send the magic link to
 * @param {object} [database] - Optional database instance (for testing)
 * @returns {{token: string, expiresAt: string}} Generated token info
 */
export function generateMagicLink(email, database) {
  let db = database || getDatabase();

  if (!email || typeof email !== 'string' || !email.includes('@'))
    throw new Error('Valid email address required');

  email = email.trim().toLowerCase();

  // Find user by email (if one exists)
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  let token     = randomBytes(TOKEN_LENGTH).toString('hex');
  let expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

  db.prepare(`
    INSERT INTO magic_link_tokens (token, user_id, email, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, user ? user.id : null, email, expiresAt);

  return { token, expiresAt };
}

/**
 * Verify a magic link token. Marks it as used on success.
 *
 * @param {string} token - The magic link token
 * @param {object} [database] - Optional database instance (for testing)
 * @returns {{userId: number|null, email: string} | null} Token info or null if invalid
 */
export function verifyMagicLink(token, database) {
  let db = database || getDatabase();

  if (!token || typeof token !== 'string')
    return null;

  let record = db.prepare(`
    SELECT id, token, user_id, email, expires_at, used_at
    FROM magic_link_tokens
    WHERE token = ?
  `).get(token);

  if (!record)
    return null;

  // Already used
  if (record.used_at)
    return null;

  // Expired
  if (new Date(record.expires_at) < new Date())
    return null;

  // Mark as used
  db.prepare(`
    UPDATE magic_link_tokens
    SET used_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(record.id);

  return {
    userId: record.user_id,
    email:  record.email,
  };
}

/**
 * Clean up expired magic link tokens.
 *
 * @param {object} [database] - Optional database instance (for testing)
 * @returns {number} Number of tokens deleted
 */
export function cleanExpiredTokens(database) {
  let db     = database || getDatabase();
  let result = db.prepare(`
    DELETE FROM magic_link_tokens
    WHERE expires_at < datetime('now')
       OR used_at IS NOT NULL
  `).run();

  return result.changes;
}

/**
 * Stub email sender. Logs to console and returns the email content.
 * This is a placeholder for a real email provider (SendGrid, SES, etc.).
 *
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Email body (text)
 * @returns {{to: string, subject: string, body: string}} Email that was "sent"
 */
export function sendEmail(to, subject, body) {
  console.log(`[Email Stub] To: ${to}`);
  console.log(`[Email Stub] Subject: ${subject}`);
  console.log(`[Email Stub] Body: ${body}`);

  return { to, subject, body };
}

export default {
  generateMagicLink,
  verifyMagicLink,
  cleanExpiredTokens,
  sendEmail,
};
