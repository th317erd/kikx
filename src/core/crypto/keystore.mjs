'use strict';

import crypto from 'node:crypto';

export class Keystore {
  constructor(options = {}) {
    this._rek     = null;
    this._devMode = options.devMode || false;
    this._devSeed = options.devSeed || null;
  }

  // --- REK (Runtime Encryption Key) ---

  // Generate or derive REK.
  // In prod: random 32 bytes. In dev: deterministic from seed.
  initialize() {
    if (this._rek)
      throw new Error('Keystore already initialized');

    if (this._devMode && this._devSeed) {
      // Deterministic: HMAC-SHA256 of seed
      this._rek = crypto.createHmac('sha256', 'kikx-dev-rek').update(this._devSeed).digest();
    } else {
      this._rek = crypto.randomBytes(32);
    }
  }

  // Zero keys from memory
  destroy() {
    if (this._rek) {
      this._rek.fill(0);
      this._rek = null;
    }
  }

  isInitialized() {
    return this._rek !== null;
  }

  // --- AES-256-GCM Encryption ---

  // Encrypt plaintext with a key.
  // Returns { ciphertext, iv, authTag } all as hex strings.
  encrypt(plaintext, key) {
    if (!key)
      key = this._rek;

    if (!key)
      throw new Error('No encryption key available');

    let iv            = crypto.randomBytes(12); // 96-bit IV for GCM
    let cipher        = crypto.createCipheriv('aes-256-gcm', key, iv);
    let inputBuffer   = (typeof plaintext === 'string') ? Buffer.from(plaintext, 'utf8') : plaintext;
    let encrypted     = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);
    let authTag       = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('hex'),
      iv:         iv.toString('hex'),
      authTag:    authTag.toString('hex'),
    };
  }

  // Decrypt ciphertext.
  // Input: { ciphertext, iv, authTag } as hex strings. Returns Buffer.
  decrypt(encryptedData, key) {
    if (!key)
      key = this._rek;

    if (!key)
      throw new Error('No encryption key available');

    let iv         = Buffer.from(encryptedData.iv, 'hex');
    let authTag    = Buffer.from(encryptedData.authTag, 'hex');
    let ciphertext = Buffer.from(encryptedData.ciphertext, 'hex');

    let decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // --- UMK Wrapping ---

  // Wrap a UMK (User Master Key) with the REK for storage in JWT vault claim
  wrapUMK(umk) {
    if (!this._rek)
      throw new Error('Keystore not initialized');

    return this.encrypt(umk, this._rek);
  }

  // Unwrap a UMK from JWT vault claim
  unwrapUMK(wrappedUMK) {
    if (!this._rek)
      throw new Error('Keystore not initialized');

    return this.decrypt(wrappedUMK, this._rek);
  }

  // Generate a new random UMK (32 bytes)
  generateUMK() {
    return crypto.randomBytes(32);
  }

  // --- Password Slot (scrypt) ---

  // Derive a slot key from a password using scrypt
  async derivePasswordSlotKey(password, salt) {
    if (!salt)
      salt = crypto.randomBytes(32);

    if (typeof salt === 'string')
      salt = Buffer.from(salt, 'hex');

    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
        if (error)
          return reject(error);

        resolve({ key: derivedKey, salt: salt.toString('hex') });
      });
    });
  }

  // Create a password slot: encrypts UMK with password-derived key
  async createPasswordSlot(umk, password) {
    let { key, salt } = await this.derivePasswordSlotKey(password);
    let encryptedUMK  = this.encrypt(umk, key);

    return { ...encryptedUMK, salt };
  }

  // Open a password slot: decrypts UMK using password-derived key
  async openPasswordSlot(slot, password) {
    let { key } = await this.derivePasswordSlotKey(password, slot.salt);

    return this.decrypt(slot, key);
  }

  // --- Per-User Key Derivation ---

  // Derive a per-user key from UMK + userId (HMAC-SHA256)
  deriveUserKey(umk, userId) {
    return crypto.createHmac('sha256', umk).update(userId).digest();
  }

  // --- Fingerprinting ---

  // Create HMAC-SHA256 fingerprint from a per-user key
  fingerprint(data, userKey) {
    if (typeof data !== 'string')
      data = JSON.stringify(data);

    return crypto.createHmac('sha256', userKey).update(data).digest('hex');
  }

  // --- Envelope Signing ---

  // Canonicalize data into a deterministic JSON string.
  // Sorts object keys recursively, handles nested objects and arrays.
  canonicalize(data) {
    return JSON.stringify(data, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        let sorted = {};
        let keys   = Object.keys(value).sort();

        for (let i = 0; i < keys.length; i++)
          sorted[keys[i]] = value[keys[i]];

        return sorted;
      }

      return value;
    });
  }

  // Sign data with the system key (REK). Returns hex HMAC-SHA256.
  sign(data) {
    if (!this._rek)
      throw new Error('Keystore not initialized');

    let blob = (typeof data === 'string') ? data : this.canonicalize(data);
    return crypto.createHmac('sha256', this._rek).update(blob).digest('hex');
  }

  // Verify a signature against data using the system key (REK).
  verify(data, signature) {
    if (!this._rek)
      throw new Error('Keystore not initialized');

    let expected = this.sign(data);
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  }
}
