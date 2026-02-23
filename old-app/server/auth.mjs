'use strict';

import jwt from 'jsonwebtoken';
import config from './config.mjs';
import { getDatabase } from './database.mjs';
import {
  hashPassword,
  verifyPassword,
  encryptWithPassword,
  decryptWithPassword,
  encryptWithKey,
  decryptWithKey,
  generateKey,
} from './encryption.mjs';

/**
 * Create a new user with encrypted secret.
 *
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<{id: number, username: string}>} Created user
 */
export async function createUser(username, password) {
  let db = getDatabase();

  // Check if user already exists
  let existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

  if (existing)
    throw new Error(`User "${username}" already exists`);

  // Hash password for authentication
  let passwordHash = await hashPassword(password);

  // Generate and encrypt the user's secret (contains data encryption key)
  let dataKey         = generateKey();
  let secret          = JSON.stringify({ dataKey });
  let encryptedSecret = await encryptWithPassword(secret, password);

  // Insert user
  let result = db.prepare(`
    INSERT INTO users (username, password_hash, encrypted_secret)
    VALUES (?, ?, ?)
  `).run(username, passwordHash, encryptedSecret);

  return {
    id:       result.lastInsertRowid,
    username: username,
  };
}

/**
 * Authenticate a user and return their decrypted secret.
 *
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<{id: number, username: string, secret: object} | null>} User with secret or null if auth fails
 */
export async function authenticateUser(username, password) {
  let db   = getDatabase();
  let user = db.prepare('SELECT id, username, password_hash, encrypted_secret FROM users WHERE username = ?').get(username);

  if (!user)
    return null;

  let valid = await verifyPassword(password, user.password_hash);

  if (!valid)
    return null;

  // Decrypt the user's secret
  let secretJson = await decryptWithPassword(user.encrypted_secret, password);
  let secret     = JSON.parse(secretJson);

  return {
    id:       user.id,
    username: user.username,
    secret:   secret,
  };
}

/**
 * Generate a JWT token for an authenticated user.
 *
 * @param {object} user - User object with id, username, secret
 * @returns {string} JWT token
 */
export function generateToken(user) {
  let payload = {
    sub:      user.id,
    username: user.username,
    secret:   user.secret,
  };

  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

/**
 * Verify and decode a JWT token.
 *
 * @param {string} token - JWT token
 * @returns {{sub: number, username: string, secret: object} | null} Decoded payload or null if invalid
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (error) {
    return null;
  }
}

/**
 * Change a user's password.
 * Re-encrypts the secret with the new password.
 *
 * @param {string} username - Username
 * @param {string} oldPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Promise<boolean>} True if password changed successfully
 */
export async function changePassword(username, oldPassword, newPassword) {
  let db   = getDatabase();
  let user = db.prepare('SELECT id, password_hash, encrypted_secret FROM users WHERE username = ?').get(username);

  if (!user)
    throw new Error(`User "${username}" not found`);

  // Verify old password
  let valid = await verifyPassword(oldPassword, user.password_hash);

  if (!valid)
    throw new Error('Invalid current password');

  // Decrypt secret with old password
  let secretJson = await decryptWithPassword(user.encrypted_secret, oldPassword);

  // Re-encrypt secret with new password
  let newEncryptedSecret = await encryptWithPassword(secretJson, newPassword);

  // Hash new password
  let newPasswordHash = await hashPassword(newPassword);

  // Update user
  db.prepare(`
    UPDATE users
    SET password_hash = ?, encrypted_secret = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newPasswordHash, newEncryptedSecret, user.id);

  return true;
}

/**
 * Update a user's encryption keys.
 * Generates a new dataKey and re-encrypts all user data.
 *
 * @param {string} username - Username
 * @param {string} password - User's password
 * @returns {Promise<boolean>} True if update successful
 */
export async function updateUserEncryption(username, password) {
  let db   = getDatabase();
  let user = db.prepare('SELECT id, password_hash, encrypted_secret FROM users WHERE username = ?').get(username);

  if (!user)
    throw new Error(`User "${username}" not found`);

  // Verify password
  let valid = await verifyPassword(password, user.password_hash);

  if (!valid)
    throw new Error('Invalid password');

  // Decrypt current secret
  let secretJson = await decryptWithPassword(user.encrypted_secret, password);
  let secret     = JSON.parse(secretJson);
  let oldDataKey = secret.dataKey;

  // Generate new data key
  let newDataKey  = generateKey();
  secret.dataKey  = newDataKey;

  // Re-encrypt secret with password
  let newEncryptedSecret = await encryptWithPassword(JSON.stringify(secret), password);

  // Start transaction
  let transaction = db.transaction(() => {
    // Update user's encrypted secret
    db.prepare(`
      UPDATE users
      SET encrypted_secret = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newEncryptedSecret, user.id);

    // Re-encrypt all agents for this user
    let agents = db.prepare('SELECT id, encrypted_api_key, encrypted_config FROM agents WHERE user_id = ?').all(user.id);

    for (let agent of agents) {
      let updates = {};

      if (agent.encrypted_api_key) {
        let apiKey                = decryptWithKey(agent.encrypted_api_key, oldDataKey);
        updates.encrypted_api_key = encryptWithKey(apiKey, newDataKey);
      }

      if (agent.encrypted_config) {
        let agentConfig          = decryptWithKey(agent.encrypted_config, oldDataKey);
        updates.encrypted_config = encryptWithKey(agentConfig, newDataKey);
      }

      if (Object.keys(updates).length > 0) {
        let setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
        let values     = [...Object.values(updates), user.id, agent.id];

        db.prepare(`
          UPDATE agents
          SET ${setClauses}, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND id = ?
        `).run(...values);
      }
    }
  });

  transaction();

  return true;
}

/**
 * Get a user by ID.
 *
 * @param {number} userId - User ID
 * @returns {object | null} User object or null
 */
export function getUserById(userId) {
  let db = getDatabase();
  return db.prepare('SELECT id, username, created_at, updated_at FROM users WHERE id = ?').get(userId);
}

/**
 * Get a user by username.
 *
 * @param {string} username - Username
 * @returns {object | null} User object or null
 */
export function getUserByUsername(username) {
  let db = getDatabase();
  return db.prepare('SELECT id, username, created_at, updated_at FROM users WHERE username = ?').get(username);
}

export default {
  createUser,
  authenticateUser,
  generateToken,
  verifyToken,
  changePassword,
  updateUserEncryption,
  getUserById,
  getUserByUsername,
};
