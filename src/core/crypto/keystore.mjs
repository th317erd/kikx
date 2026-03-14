'use strict';

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';

export class Keystore {
  constructor(options = {}) {
    this._rek             = null;
    this._smk             = null;
    this._systemPublicKey  = null;
    this._systemPrivateKey = null;
    this._devMode         = options.devMode || false;
    this._devSeed         = options.devSeed || null;
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

    if (this._smk) {
      this._smk.fill(0);
      this._smk = null;
    }

    this._systemPublicKey  = null;
    this._systemPrivateKey = null;
  }

  isInitialized() {
    return this._rek !== null;
  }

  // --- SMK (Server Master Key) ---

  // Load or generate the Server Master Key from disk.
  // Reads hex-encoded 32 bytes from configDir/server.key (or KIKX_SERVER_KEY_FILE env var).
  // If the file doesn't exist, generates a new key and writes it.
  loadServerMasterKey(configDir) {
    if (!configDir)
      throw new Error('configDir is required');

    let keyPath = process.env.KIKX_SERVER_KEY_FILE || path.join(configDir, 'server.key');

    // Ensure config directory exists
    let keyDir = path.dirname(keyPath);
    if (!fs.existsSync(keyDir))
      fs.mkdirSync(keyDir, { recursive: true });

    if (fs.existsSync(keyPath)) {
      let hex = fs.readFileSync(keyPath, 'utf8').trim();
      this._validateSmkHex(hex);
      this._smk = Buffer.from(hex, 'hex');
    } else {
      this._smk = crypto.randomBytes(32);
      let hex   = this._smk.toString('hex');

      fs.writeFileSync(keyPath, hex, { mode: 0o600 });
    }
  }

  // Validate that a string is exactly 64 hex characters (32 bytes).
  _validateSmkHex(hex) {
    if (!hex || hex.length === 0)
      throw new Error('Server key file is empty');

    if (!/^[0-9a-f]+$/i.test(hex))
      throw new Error('Server key file contains non-hex characters');

    if (hex.length !== 64)
      throw new Error(`Server key file must contain exactly 64 hex characters (32 bytes), got ${hex.length}`);
  }

  // --- Ed25519 Signing ---

  // Generate an Ed25519 signing key pair.
  // Returns { publicKey, privateKey } as PEM strings.
  generateSigningKeyPair() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    return { publicKey, privateKey };
  }

  // Sign data with an Ed25519 private key.
  // Canonicalizes objects, then signs. Returns hex string.
  signWithPrivateKey(data, privateKeyPEM) {
    if (data == null)
      throw new Error('Data is required for signing');

    if (privateKeyPEM == null)
      throw new Error('Private key is required for signing');

    let blob      = (typeof data === 'string') ? data : this.canonicalize(data);
    let signature = crypto.sign(null, Buffer.from(blob), privateKeyPEM);

    return signature.toString('hex');
  }

  // Verify an Ed25519 signature against data.
  // Returns boolean. Returns false (not throw) for invalid keys or signatures.
  verifyWithPublicKey(data, publicKeyPEM, signatureHex) {
    try {
      if (data == null || publicKeyPEM == null || signatureHex == null)
        return false;

      let blob = (typeof data === 'string') ? data : this.canonicalize(data);

      return crypto.verify(null, Buffer.from(blob), publicKeyPEM, Buffer.from(signatureHex, 'hex'));
    } catch (_error) {
      return false;
    }
  }

  // --- Actor Key Encryption (SMK-derived) ---

  // Encrypt an actor's private key PEM using an SMK-derived key.
  encryptActorPrivateKey(privateKeyPEM, actorID) {
    if (!this._smk)
      throw new Error('Server Master Key not loaded');

    if (privateKeyPEM == null)
      throw new Error('Private key PEM is required');

    if (actorID == null)
      throw new Error('Actor ID is required');

    let derivedKey = crypto.createHmac('sha256', this._smk).update(actorID).digest();

    return this.encrypt(privateKeyPEM, derivedKey);
  }

  // Decrypt an actor's private key PEM using an SMK-derived key.
  decryptActorPrivateKey(encryptedData, actorID) {
    if (!this._smk)
      throw new Error('Server Master Key not loaded');

    if (encryptedData == null)
      throw new Error('Encrypted data is required');

    if (actorID == null)
      throw new Error('Actor ID is required');

    let derivedKey = crypto.createHmac('sha256', this._smk).update(actorID).digest();

    return this.decrypt(encryptedData, derivedKey).toString('utf8');
  }

  // --- User Key Encryption (UMK-derived) ---

  // Encrypt a user's private key PEM using a UMK-derived key.
  encryptUserPrivateKey(privateKeyPEM, umk, userID) {
    if (privateKeyPEM == null)
      throw new Error('Private key PEM is required');

    if (umk == null)
      throw new Error('UMK is required');

    if (userID == null)
      throw new Error('User ID is required');

    let derivedKey = this.deriveUserKey(umk, userID);

    return this.encrypt(privateKeyPEM, derivedKey);
  }

  // Decrypt a user's private key PEM using a UMK-derived key.
  decryptUserPrivateKey(encryptedData, umk, userID) {
    if (encryptedData == null)
      throw new Error('Encrypted data is required');

    if (umk == null)
      throw new Error('UMK is required');

    if (userID == null)
      throw new Error('User ID is required');

    let derivedKey = this.deriveUserKey(umk, userID);

    return this.decrypt(encryptedData, derivedKey).toString('utf8');
  }

  // --- System Key Pair (file-based) ---

  // Load or generate the system signing key pair from disk.
  // Reads system-signing.pub (PEM) and system-signing.key.enc (JSON envelope) from configDir.
  // Requires SMK to be loaded first.
  loadSystemKeyPair(configDir) {
    if (!this._smk)
      throw new Error('Server Master Key must be loaded before loading system key pair');

    if (!configDir)
      throw new Error('configDir is required');

    let publicKeyPath  = path.join(configDir, 'system-signing.pub');
    let privateKeyPath = path.join(configDir, 'system-signing.key.enc');

    // Ensure config directory exists
    if (!fs.existsSync(configDir))
      fs.mkdirSync(configDir, { recursive: true });

    if (fs.existsSync(publicKeyPath) && fs.existsSync(privateKeyPath)) {
      // Load existing key pair
      this._systemPublicKey = fs.readFileSync(publicKeyPath, 'utf8');

      let envelope          = JSON.parse(fs.readFileSync(privateKeyPath, 'utf8'));
      this._systemPrivateKey = this.decrypt(envelope, this._smk).toString('utf8');
    } else {
      // Generate new key pair
      let { publicKey, privateKey } = this.generateSigningKeyPair();

      this._systemPublicKey  = publicKey;
      this._systemPrivateKey = privateKey;

      // Write public key as plain PEM
      fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });

      // Encrypt and write private key
      let envelope = this.encrypt(privateKey, this._smk);
      fs.writeFileSync(privateKeyPath, JSON.stringify(envelope), { mode: 0o600 });
    }
  }

  // Sign data with the system private key (Ed25519).
  systemSign(data) {
    if (!this._systemPrivateKey)
      throw new Error('System key pair not loaded');

    return this.signWithPrivateKey(data, this._systemPrivateKey);
  }

  // Verify data against a signature using the system public key (Ed25519).
  systemVerify(data, signatureHex) {
    return this.verifyWithPublicKey(data, this._systemPublicKey, signatureHex);
  }

  // Get the system public key PEM.
  getSystemPublicKey() {
    return this._systemPublicKey;
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

  // Derive a per-user key from UMK + userID (HMAC-SHA256)
  deriveUserKey(umk, userID) {
    return crypto.createHmac('sha256', umk).update(userID).digest();
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
