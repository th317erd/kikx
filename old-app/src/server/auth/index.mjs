'use strict';

import crypto from 'node:crypto';

// =============================================================================
// AuthService
// =============================================================================
// Password-only JWT auth with zero-knowledge vault (UMK wrapped by REK in JWT).
//
// JWT-as-Vault architecture:
//   - REK (Runtime Encryption Key): random 32 bytes, exists ONLY in process memory
//   - UMK (User Master Key): per-user key, wrapped by REK in JWT vault claim
//   - Password slot: scrypt(password) -> slot key -> wraps UMK -> stored on User
//
// On every login, UMK is unwrapped from the password slot, then re-wrapped
// with REK for the JWT. Server restarts (new REK) invalidate all JWTs by design.
// =============================================================================

// --- JWT Helpers (raw crypto, no external dependency) ---

const JWT_ALGORITHM = 'HS256';
const JWT_TYPE      = 'JWT';

function base64urlEncode(data) {
  let buffer = (typeof data === 'string') ? Buffer.from(data, 'utf8') : data;

  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  // Restore base64 padding
  let padded = str + '='.repeat((4 - (str.length % 4)) % 4);

  return Buffer.from(
    padded.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
}

function hmacSHA256(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function createJWT(payload, secret) {
  let header    = base64urlEncode(JSON.stringify({ alg: JWT_ALGORITHM, typ: JWT_TYPE }));
  let body      = base64urlEncode(JSON.stringify(payload));
  let signature = base64urlEncode(hmacSHA256(`${header}.${body}`, secret));

  return `${header}.${body}.${signature}`;
}

function verifyJWT(token, secret) {
  if (!token || typeof token !== 'string')
    throw new AuthError('Malformed token');

  let parts = token.split('.');
  if (parts.length !== 3)
    throw new AuthError('Malformed token');

  let [ header, body, signature ] = parts;

  // Verify signature (constant-time comparison)
  let expected = base64urlEncode(hmacSHA256(`${header}.${body}`, secret));

  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
    throw new AuthError('Invalid token signature');

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8'));
  } catch (_error) {
    throw new AuthError('Malformed token payload');
  }

  // Check expiration
  if (payload.exp && (Date.now() / 1000) > payload.exp)
    throw new AuthError('Token expired');

  return payload;
}

// --- Errors ---

export class AuthError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name       = 'AuthError';
    this.code       = code || 'AUTH_ERROR';
    this.statusCode = statusCode || 401;
  }
}

// --- Validation ---

const EMAIL_PATTERN      = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN   = 8;
const DEFAULT_EXPIRY_SEC = 30 * 24 * 60 * 60; // 30 days

function validateEmail(email) {
  if (!email || typeof email !== 'string')
    throw new AuthError('Email is required', 'INVALID_EMAIL', 400);

  let trimmed = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(trimmed))
    throw new AuthError('Invalid email format', 'INVALID_EMAIL', 400);

  return trimmed;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string')
    throw new AuthError('Password is required', 'INVALID_PASSWORD', 400);

  if (password.length < MIN_PASSWORD_LEN)
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LEN} characters`, 'INVALID_PASSWORD', 400);
}

// --- AuthService ---

export class AuthService {
  constructor({ context, keystore }) {
    if (!context)
      throw new Error('AuthService requires a context');

    if (!keystore)
      throw new Error('AuthService requires a keystore');

    this._context   = context;
    this._keystore  = keystore;
    this._jwtSecret = null;

    // Derive JWT secret from REK so it's tied to the REK lifecycle.
    // Server restart (new REK) = all JWTs invalidated.
    this._deriveJWTSecret();
  }

  // --- JWT Secret Derivation ---

  _deriveJWTSecret() {
    if (!this._keystore.isInitialized())
      throw new Error('Keystore must be initialized before creating AuthService');

    // HMAC-SHA256(REK, 'kikx-jwt-secret')
    // We access _rek directly since there's no public accessor — acceptable
    // for this tightly coupled server component.
    this._jwtSecret = crypto.createHmac('sha256', this._keystore._rek).update('kikx-jwt-secret').digest();
  }

  // --- Models Accessor ---

  _getModels() {
    let models = this._context.getProperty('models');
    if (!models)
      throw new Error('Models not available on context');

    return models;
  }

  // --- Registration ---

  async register(email, password, options = {}) {
    let normalizedEmail = validateEmail(email);
    validatePassword(password);

    let models = this._getModels();
    let { Organization, User, Role } = models;

    // Check for existing user
    let existing = await User.where.email.EQ(normalizedEmail).first();
    if (existing)
      throw new AuthError('Email already registered', 'DUPLICATE_EMAIL', 409);

    // Create organization
    let orgName      = options.organizationName || `${normalizedEmail}'s Organization`;
    let organization = await Organization.create({ name: orgName });

    // Generate UMK
    let umk = this._keystore.generateUMK();

    // Create password slot (scrypt + AES-256-GCM)
    let passwordSlot = await this._keystore.createPasswordSlot(umk, password);

    // Create user
    let user = await User.create({
      organizationID: organization.id,
      email:          normalizedEmail,
      firstName:      options.firstName || null,
      lastName:       options.lastName || null,
      passwordSlot:   JSON.stringify(passwordSlot),
    });

    // Generate Ed25519 signing key pair for user
    let { publicKey: signingPublicKey, privateKey: signingPrivateKey } = this._keystore.generateSigningKeyPair();
    let encryptedSigningKey = this._keystore.encryptUserPrivateKey(signingPrivateKey, umk, user.id);

    user.publicKey           = signingPublicKey;
    user.encryptedPrivateKey = JSON.stringify(encryptedSigningKey);
    await user.save();

    // Create default admin role
    await Role.create({
      organizationID: organization.id,
      userID:         user.id,
      name:           'admin',
    });

    // Generate JWT with vault claim
    let token = this.generateToken(user, umk, options);

    return { user, token, organization };
  }

  // --- Login ---

  async login(email, password) {
    let normalizedEmail = validateEmail(email);

    let models = this._getModels();
    let { User } = models;

    // Find user (email is already lowercase due to model onBeforeSave)
    let user = await User.where.email.EQ(normalizedEmail).first();
    if (!user)
      throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS');

    // Parse stored password slot
    let passwordSlot;
    try {
      passwordSlot = JSON.parse(user.passwordSlot);
    } catch (_error) {
      throw new AuthError('Invalid password slot', 'CORRUPTED_SLOT');
    }

    // Open password slot: scrypt-derive key from password, decrypt UMK
    let umk;
    try {
      umk = await this._keystore.openPasswordSlot(passwordSlot, password);
    } catch (_error) {
      throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    // Generate Ed25519 key pair for pre-existing users who lack one
    if (!user.encryptedPrivateKey) {
      let { publicKey: signingPublicKey, privateKey: signingPrivateKey } = this._keystore.generateSigningKeyPair();
      let encryptedSigningKey = this._keystore.encryptUserPrivateKey(signingPrivateKey, umk, user.id);

      user.publicKey           = signingPublicKey;
      user.encryptedPrivateKey = JSON.stringify(encryptedSigningKey);
      await user.save();
    }

    // Generate JWT with vault claim (UMK re-wrapped with REK)
    let token = this.generateToken(user, umk);

    return { user, token };
  }

  // --- Token Generation ---

  generateToken(user, umk, options = {}) {
    // Wrap UMK with REK for the vault claim
    let vault = this._keystore.wrapUMK(umk);

    let now     = Math.floor(Date.now() / 1000);
    let expiry  = options.expiresIn || DEFAULT_EXPIRY_SEC;

    let payload = {
      sub:   user.id,
      org:   user.organizationID,
      vault: vault,
      iat:   now,
      exp:   now + expiry,
    };

    return createJWT(payload, this._jwtSecret);
  }

  // --- Token Verification ---

  verifyToken(token) {
    return verifyJWT(token, this._jwtSecret);
  }

  // --- UMK Extraction ---

  getUMK(decoded) {
    if (!decoded || !decoded.vault)
      throw new AuthError('No vault claim in token', 'MISSING_VAULT');

    return this._keystore.unwrapUMK(decoded.vault);
  }

  // --- JWT Secret Accessor (for testing) ---

  getJWTSecret() {
    return this._jwtSecret;
  }
}

// --- Auth Middleware ---

function extractToken(req) {
  // 1. Cookie header: "token=xxx" or "kikx_token=xxx"
  let cookieHeader = req.headers && req.headers.cookie;
  if (cookieHeader) {
    let cookies = parseCookies(cookieHeader);
    if (cookies.kikx_token)
      return cookies.kikx_token;

    if (cookies.token)
      return cookies.token;
  }

  // 2. Authorization header: "Bearer xxx"
  let authHeader = req.headers && req.headers.authorization;
  if (authHeader) {
    let parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer')
      return parts[1];
  }

  // 3. Query parameter: ?token=xxx (for EventSource/SSE which can't set headers)
  let url  = req.url || '';
  let qIdx = url.indexOf('?');
  if (qIdx >= 0) {
    let params = new URLSearchParams(url.substring(qIdx));
    let qToken = params.get('token');
    if (qToken)
      return qToken;
  }

  return null;
}

function parseCookies(cookieString) {
  let cookies = {};

  if (!cookieString)
    return cookies;

  let pairs = cookieString.split(';');
  for (let i = 0; i < pairs.length; i++) {
    let pair  = pairs[i].trim();
    let eqIdx = pair.indexOf('=');

    if (eqIdx < 0)
      continue;

    let name  = pair.substring(0, eqIdx).trim();
    let value = pair.substring(eqIdx + 1).trim();

    cookies[name] = value;
  }

  return cookies;
}

export function createAuthMiddleware(authService) {
  return function authMiddleware(req) {
    let token = extractToken(req);
    if (!token)
      throw new AuthError('No token provided', 'MISSING_TOKEN');

    let decoded = authService.verifyToken(token);

    // Attach to request
    req.userID         = decoded.sub;
    req.organizationID = decoded.org;
    req.getUMK         = () => authService.getUMK(decoded);
  };
}

// --- Exported Helpers (for testing) ---

export {
  base64urlEncode,
  base64urlDecode,
  createJWT,
  verifyJWT,
  extractToken,
  parseCookies,
  DEFAULT_EXPIRY_SEC,
  MIN_PASSWORD_LEN,
};
