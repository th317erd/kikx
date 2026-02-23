'use strict';

import { randomBytes, createCipheriv, createDecipheriv, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

// AES-256-GCM configuration
const ALGORITHM   = 'aes-256-gcm';
const IV_LENGTH   = 12;  // 96 bits for GCM
const TAG_LENGTH  = 16;  // 128 bits auth tag
const KEY_LENGTH  = 32;  // 256 bits for AES-256
const SALT_LENGTH = 32;  // 256 bits for scrypt salt

/**
 * Derive a key from a password using scrypt.
 *
 * @param {string} password - The password to derive from
 * @param {Buffer} salt - Salt for key derivation
 * @returns {Promise<Buffer>} Derived key
 */
async function deriveKey(password, salt) {
  return await scryptAsync(password, salt, KEY_LENGTH);
}

/**
 * Encrypt data using AES-256-GCM with a password.
 * The output format is: salt (32 bytes) + iv (12 bytes) + authTag (16 bytes) + ciphertext
 *
 * @param {string} plaintext - Data to encrypt
 * @param {string} password - Password to encrypt with
 * @returns {Promise<string>} Base64-encoded encrypted data
 */
export async function encryptWithPassword(plaintext, password) {
  let salt = randomBytes(SALT_LENGTH);
  let key  = await deriveKey(password, salt);
  let iv   = randomBytes(IV_LENGTH);

  let cipher     = createCipheriv(ALGORITHM, key, iv);
  let encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  let authTag    = cipher.getAuthTag();

  // Combine: salt + iv + authTag + ciphertext
  let combined = Buffer.concat([salt, iv, authTag, encrypted]);

  return combined.toString('base64');
}

/**
 * Decrypt data that was encrypted with encryptWithPassword.
 *
 * @param {string} encryptedBase64 - Base64-encoded encrypted data
 * @param {string} password - Password to decrypt with
 * @returns {Promise<string>} Decrypted plaintext
 * @throws {Error} If decryption fails (wrong password or corrupted data)
 */
export async function decryptWithPassword(encryptedBase64, password) {
  let combined = Buffer.from(encryptedBase64, 'base64');

  if (combined.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
    throw new Error('Invalid encrypted data: too short');

  let salt       = combined.subarray(0, SALT_LENGTH);
  let iv         = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  let authTag    = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  let ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  let key = await deriveKey(password, salt);

  let decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error('Decryption failed: invalid password or corrupted data');
  }
}

/**
 * Encrypt data using AES-256-GCM with a hex-encoded key.
 * The output format is: iv (12 bytes) + authTag (16 bytes) + ciphertext
 *
 * @param {string} plaintext - Data to encrypt
 * @param {string} keyHex - Hex-encoded 256-bit key
 * @returns {string} Base64-encoded encrypted data
 */
export function encryptWithKey(plaintext, keyHex) {
  let key = Buffer.from(keyHex, 'hex');

  if (key.length !== KEY_LENGTH)
    throw new Error(`Invalid key length: expected ${KEY_LENGTH} bytes, got ${key.length}`);

  let iv = randomBytes(IV_LENGTH);

  let cipher    = createCipheriv(ALGORITHM, key, iv);
  let encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  let authTag   = cipher.getAuthTag();

  // Combine: iv + authTag + ciphertext
  let combined = Buffer.concat([iv, authTag, encrypted]);

  return combined.toString('base64');
}

/**
 * Decrypt data that was encrypted with encryptWithKey.
 *
 * @param {string} encryptedBase64 - Base64-encoded encrypted data
 * @param {string} keyHex - Hex-encoded 256-bit key
 * @returns {string} Decrypted plaintext
 * @throws {Error} If decryption fails
 */
export function decryptWithKey(encryptedBase64, keyHex) {
  let key = Buffer.from(keyHex, 'hex');

  if (key.length !== KEY_LENGTH)
    throw new Error(`Invalid key length: expected ${KEY_LENGTH} bytes, got ${key.length}`);

  let combined = Buffer.from(encryptedBase64, 'base64');

  if (combined.length < IV_LENGTH + TAG_LENGTH)
    throw new Error('Invalid encrypted data: too short');

  let iv         = combined.subarray(0, IV_LENGTH);
  let authTag    = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  let ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);

  let decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error('Decryption failed: invalid key or corrupted data');
  }
}

/**
 * Generate a random 256-bit key as hex string.
 *
 * @returns {string} Hex-encoded 256-bit key
 */
export function generateKey() {
  return randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Hash a password using scrypt for storage.
 * Output format: salt (hex) + ':' + hash (hex)
 *
 * @param {string} password - Password to hash
 * @returns {Promise<string>} Hash string in format "salt:hash"
 */
export async function hashPassword(password) {
  let salt = randomBytes(SALT_LENGTH);
  let hash = await scryptAsync(password, salt, 64);

  return salt.toString('hex') + ':' + hash.toString('hex');
}

/**
 * Verify a password against a stored hash.
 *
 * @param {string} password - Password to verify
 * @param {string} storedHash - Stored hash in format "salt:hash"
 * @returns {Promise<boolean>} True if password matches
 */
export async function verifyPassword(password, storedHash) {
  let parts = storedHash.split(':');

  if (parts.length !== 2)
    return false;

  let salt       = Buffer.from(parts[0], 'hex');
  let storedKey  = Buffer.from(parts[1], 'hex');
  let derivedKey = await scryptAsync(password, salt, 64);

  return timingSafeEqual(storedKey, derivedKey);
}

export default {
  encryptWithPassword,
  decryptWithPassword,
  encryptWithKey,
  decryptWithKey,
  generateKey,
  hashPassword,
  verifyPassword,
};
