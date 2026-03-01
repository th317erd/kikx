'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { KikxCore }  from '../../src/core/kikx-core.mjs';
import { Keystore }  from '../../src/core/crypto/keystore.mjs';
import {
  AuthService,
  AuthError,
  createAuthMiddleware,
  base64urlEncode,
  base64urlDecode,
  createJWT,
  verifyJWT,
  DEFAULT_EXPIRY_SEC,
  MIN_PASSWORD_LEN,
} from '../../src/server/auth/index.mjs';

// =============================================================================
// Shared setup: one KikxCore + Keystore for all tests
// =============================================================================

let core, keystore, context, authService;

before(async () => {
  core = new KikxCore({ database: { filename: ':memory:' } });
  await core.start();

  keystore = new Keystore({ devMode: true, devSeed: 'test-auth-seed' });
  keystore.initialize();

  context = core.getContext();
  context.setProperty('keystore', keystore);

  authService = new AuthService({ context, keystore });
});

after(async () => {
  keystore.destroy();
  await core.stop();
});

// =============================================================================
// AuthService constructor
// =============================================================================

describe('AuthService constructor', () => {
  it('should require context', () => {
    assert.throws(
      () => new AuthService({ keystore }),
      { message: 'AuthService requires a context' },
    );
  });

  it('should require keystore', () => {
    assert.throws(
      () => new AuthService({ context }),
      { message: 'AuthService requires a keystore' },
    );
  });

  it('should require keystore to be initialized', () => {
    let uninitKeystore = new Keystore();

    assert.throws(
      () => new AuthService({ context, keystore: uninitKeystore }),
      { message: 'Keystore must be initialized before creating AuthService' },
    );
  });

  it('should derive JWT secret from REK on construction', () => {
    let secret = authService.getJWTSecret();
    assert.ok(Buffer.isBuffer(secret));
    assert.equal(secret.length, 32);
  });
});

// =============================================================================
// JWT Secret Derivation
// =============================================================================

describe('JWT secret derivation', () => {
  it('should derive JWT secret from REK using HMAC-SHA256', () => {
    // Manually compute expected secret
    let expected = crypto.createHmac('sha256', keystore._rek).update('kikx-jwt-secret').digest();
    let actual   = authService.getJWTSecret();

    assert.deepEqual(actual, expected);
  });

  it('should produce different secrets for different REKs', () => {
    let ks2 = new Keystore({ devMode: true, devSeed: 'different-seed' });
    ks2.initialize();

    let as2     = new AuthService({ context, keystore: ks2 });
    let secret1 = authService.getJWTSecret();
    let secret2 = as2.getJWTSecret();

    assert.notDeepEqual(secret1, secret2);
    ks2.destroy();
  });
});

// =============================================================================
// base64url encoding/decoding
// =============================================================================

describe('base64url encoding/decoding', () => {
  it('should roundtrip a string', () => {
    let original = 'Hello, JWT world!';
    let encoded  = base64urlEncode(original);
    let decoded  = base64urlDecode(encoded).toString('utf8');

    assert.equal(decoded, original);
  });

  it('should roundtrip binary data', () => {
    let original = crypto.randomBytes(64);
    let encoded  = base64urlEncode(original);
    let decoded  = base64urlDecode(encoded);

    assert.deepEqual(decoded, original);
  });

  it('should not contain +, /, or = characters', () => {
    // Use data that would produce + / = in standard base64
    let data    = Buffer.from([0xfb, 0xff, 0xfe, 0x00, 0x01, 0x02]);
    let encoded = base64urlEncode(data);

    assert.ok(!encoded.includes('+'), 'Should not contain +');
    assert.ok(!encoded.includes('/'), 'Should not contain /');
    assert.ok(!encoded.includes('='), 'Should not contain =');
  });

  it('should roundtrip JSON payload', () => {
    let payload = { sub: 'usr_abc', org: 'org_xyz', iat: 1234567890 };
    let encoded = base64urlEncode(JSON.stringify(payload));
    let decoded = JSON.parse(base64urlDecode(encoded).toString('utf8'));

    assert.deepEqual(decoded, payload);
  });
});

// =============================================================================
// Registration
// =============================================================================

describe('AuthService.register', () => {
  it('should create user, org, and role', async () => {
    let result = await authService.register('alice@example.com', 'securepass123');

    assert.ok(result.user);
    assert.ok(result.organization);
    assert.ok(result.token);
    assert.ok(result.user.id.startsWith('usr_'));
    assert.ok(result.organization.id.startsWith('org_'));
    assert.equal(result.user.email, 'alice@example.com');
  });

  it('should create a password slot on the user', async () => {
    let result = await authService.register('bob@example.com', 'securepass123');
    let slot   = JSON.parse(result.user.passwordSlot);

    assert.ok(slot.ciphertext, 'should have ciphertext');
    assert.ok(slot.iv, 'should have iv');
    assert.ok(slot.authTag, 'should have authTag');
    assert.ok(slot.salt, 'should have salt');
  });

  it('should return a valid JWT token', async () => {
    let result  = await authService.register('carol@example.com', 'securepass123');
    let decoded = authService.verifyToken(result.token);

    assert.equal(decoded.sub, result.user.id);
    assert.equal(decoded.org, result.organization.id);
    assert.ok(decoded.vault);
    assert.ok(decoded.iat);
    assert.ok(decoded.exp);
  });

  it('should reject duplicate email', async () => {
    await authService.register('dupe@example.com', 'securepass123');

    await assert.rejects(
      () => authService.register('dupe@example.com', 'securepass456'),
      { code: 'DUPLICATE_EMAIL' },
    );
  });

  it('should validate email format', async () => {
    await assert.rejects(
      () => authService.register('not-an-email', 'securepass123'),
      { code: 'INVALID_EMAIL' },
    );
  });

  it('should reject empty email', async () => {
    await assert.rejects(
      () => authService.register('', 'securepass123'),
      { code: 'INVALID_EMAIL' },
    );
  });

  it('should validate password minimum length', async () => {
    await assert.rejects(
      () => authService.register('short@example.com', 'short'),
      { code: 'INVALID_PASSWORD' },
    );
  });

  it('should reject empty password', async () => {
    await assert.rejects(
      () => authService.register('nopw@example.com', ''),
      { code: 'INVALID_PASSWORD' },
    );
  });

  it('should use custom organization name when provided', async () => {
    let result = await authService.register('org@example.com', 'securepass123', {
      organizationName: 'My Custom Org',
    });

    assert.equal(result.organization.name, 'My Custom Org');
  });

  it('should store firstName and lastName when provided', async () => {
    let result = await authService.register('named@example.com', 'securepass123', {
      firstName: 'Jane',
      lastName:  'Doe',
    });

    assert.equal(result.user.firstName, 'Jane');
    assert.equal(result.user.lastName, 'Doe');
  });

  it('should create admin role for registered user', async () => {
    let result = await authService.register('admin@example.com', 'securepass123');
    let models = core.getModels();
    let roles  = await models.Role.where.userID.EQ(result.user.id).all();

    assert.equal(roles.length, 1);
    assert.equal(roles[0].name, 'admin');
    assert.equal(roles[0].organizationID, result.organization.id);
  });
});

// =============================================================================
// Login
// =============================================================================

describe('AuthService.login', () => {
  before(async () => {
    // Register a user to login with
    await authService.register('loginuser@example.com', 'correctpassword');
  });

  it('should login with correct credentials', async () => {
    let result = await authService.login('loginuser@example.com', 'correctpassword');

    assert.ok(result.user);
    assert.ok(result.token);
    assert.equal(result.user.email, 'loginuser@example.com');
  });

  it('should throw with wrong password', async () => {
    await assert.rejects(
      () => authService.login('loginuser@example.com', 'wrongpassword'),
      { code: 'INVALID_CREDENTIALS' },
    );
  });

  it('should throw with nonexistent email', async () => {
    await assert.rejects(
      () => authService.login('nosuchuser@example.com', 'anypassword'),
      { code: 'INVALID_CREDENTIALS' },
    );
  });

  it('should be case-insensitive for email', async () => {
    let result = await authService.login('LOGINUSER@EXAMPLE.COM', 'correctpassword');

    assert.ok(result.user);
    assert.equal(result.user.email, 'loginuser@example.com');
  });
});

// =============================================================================
// JWT structure and verification
// =============================================================================

describe('JWT structure', () => {
  let token, decoded;

  before(async () => {
    let result = await authService.register('jwttest@example.com', 'securepass123');
    token   = result.token;
    decoded = authService.verifyToken(token);
  });

  it('should contain correct sub (user ID)', () => {
    assert.ok(decoded.sub);
    assert.ok(decoded.sub.startsWith('usr_'));
  });

  it('should contain correct org (organization ID)', () => {
    assert.ok(decoded.org);
    assert.ok(decoded.org.startsWith('org_'));
  });

  it('should contain vault claim', () => {
    assert.ok(decoded.vault);
    assert.ok(decoded.vault.ciphertext);
    assert.ok(decoded.vault.iv);
    assert.ok(decoded.vault.authTag);
  });

  it('should have expiration', () => {
    assert.ok(decoded.exp);
    assert.ok(decoded.exp > decoded.iat);
    assert.equal(decoded.exp - decoded.iat, DEFAULT_EXPIRY_SEC);
  });

  it('should have issued-at timestamp', () => {
    assert.ok(decoded.iat);
    let now = Math.floor(Date.now() / 1000);
    // Should be within 5 seconds of now
    assert.ok(Math.abs(decoded.iat - now) < 5);
  });
});

describe('JWT verification', () => {
  it('should verify a valid token', async () => {
    let result  = await authService.register('verify-valid@example.com', 'securepass123');
    let decoded = authService.verifyToken(result.token);

    assert.equal(decoded.sub, result.user.id);
  });

  it('should reject an invalid signature', () => {
    let secret  = authService.getJWTSecret();
    let payload = { sub: 'usr_fake', org: 'org_fake', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
    let fakeToken = createJWT(payload, Buffer.from('wrong-secret-key-that-is-32-bytes'));

    assert.throws(
      () => authService.verifyToken(fakeToken),
      { message: 'Invalid token signature' },
    );
  });

  it('should reject an expired token', () => {
    let secret  = authService.getJWTSecret();
    let payload = {
      sub: 'usr_test',
      org: 'org_test',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
    };
    let expiredToken = createJWT(payload, secret);

    assert.throws(
      () => authService.verifyToken(expiredToken),
      { message: 'Token expired' },
    );
  });

  it('should reject a malformed token (not 3 parts)', () => {
    assert.throws(
      () => authService.verifyToken('only.two'),
      { message: 'Malformed token' },
    );
  });

  it('should reject null token', () => {
    assert.throws(
      () => authService.verifyToken(null),
      { message: 'Malformed token' },
    );
  });

  it('should reject empty string token', () => {
    assert.throws(
      () => authService.verifyToken(''),
      { message: 'Malformed token' },
    );
  });
});

// =============================================================================
// UMK extraction
// =============================================================================

describe('UMK extraction', () => {
  it('should return correct UMK from token', async () => {
    let result  = await authService.register('umk-extract@example.com', 'securepass123');
    let decoded = authService.verifyToken(result.token);
    let umk     = authService.getUMK(decoded);

    assert.ok(Buffer.isBuffer(umk));
    assert.equal(umk.length, 32);
  });

  it('should produce same UMK from login as from registration', async () => {
    // Register
    let regResult  = await authService.register('umk-roundtrip@example.com', 'securepass123');
    let regDecoded = authService.verifyToken(regResult.token);
    let regUMK     = authService.getUMK(regDecoded);

    // Login
    let loginResult  = await authService.login('umk-roundtrip@example.com', 'securepass123');
    let loginDecoded = authService.verifyToken(loginResult.token);
    let loginUMK     = authService.getUMK(loginDecoded);

    assert.deepEqual(loginUMK, regUMK);
  });

  it('should throw when vault claim is missing', () => {
    assert.throws(
      () => authService.getUMK({}),
      { code: 'MISSING_VAULT' },
    );
  });

  it('should throw for null decoded', () => {
    assert.throws(
      () => authService.getUMK(null),
      { code: 'MISSING_VAULT' },
    );
  });
});

// =============================================================================
// Password slot round-trip
// =============================================================================

describe('password slot round-trip', () => {
  it('should survive register -> login -> same UMK', async () => {
    let email    = 'slot-roundtrip@example.com';
    let password = 'roundtrippass';

    // Register (creates UMK + password slot)
    let regResult  = await authService.register(email, password);
    let regDecoded = authService.verifyToken(regResult.token);
    let regUMK     = authService.getUMK(regDecoded);

    // Login (reads password slot, extracts UMK)
    let loginResult  = await authService.login(email, password);
    let loginDecoded = authService.verifyToken(loginResult.token);
    let loginUMK     = authService.getUMK(loginDecoded);

    // UMKs must match
    assert.deepEqual(loginUMK, regUMK);
  });
});

// =============================================================================
// Auth middleware
// =============================================================================

describe('createAuthMiddleware', () => {
  let middleware, validToken;

  before(async () => {
    let result = await authService.register('middleware@example.com', 'securepass123');
    validToken = result.token;
    middleware = createAuthMiddleware(authService);
  });

  it('should extract token from cookie header', () => {
    let req = { headers: { cookie: `kikx_token=${validToken}` } };
    middleware(req);

    assert.ok(req.userId);
    assert.ok(req.organizationId);
    assert.ok(typeof req.getUMK === 'function');
  });

  it('should extract token from Authorization header', () => {
    let req = { headers: { authorization: `Bearer ${validToken}` } };
    middleware(req);

    assert.ok(req.userId);
    assert.ok(req.organizationId);
  });

  it('should prefer kikx_token cookie over token cookie', () => {
    // Create a second user to distinguish tokens
    let req = { headers: { cookie: `kikx_token=${validToken}; token=garbage` } };
    middleware(req);

    // Should succeed using kikx_token, not crash on garbage token
    assert.ok(req.userId);
  });

  it('should fall back to token cookie', () => {
    let req = { headers: { cookie: `token=${validToken}` } };
    middleware(req);

    assert.ok(req.userId);
  });

  it('should attach userId and organizationId', () => {
    let req = { headers: { authorization: `Bearer ${validToken}` } };
    middleware(req);

    assert.ok(req.userId.startsWith('usr_'));
    assert.ok(req.organizationId.startsWith('org_'));
  });

  it('should provide getUMK accessor', () => {
    let req = { headers: { authorization: `Bearer ${validToken}` } };
    middleware(req);

    let umk = req.getUMK();
    assert.ok(Buffer.isBuffer(umk));
    assert.equal(umk.length, 32);
  });

  it('should reject missing token', () => {
    let req = { headers: {} };

    assert.throws(
      () => middleware(req),
      { code: 'MISSING_TOKEN' },
    );
  });

  it('should reject invalid token', () => {
    let req = { headers: { authorization: 'Bearer invalid.token.here' } };

    assert.throws(
      () => middleware(req),
      (error) => error instanceof AuthError,
    );
  });
});

// =============================================================================
// Multiple users
// =============================================================================

describe('multiple users', () => {
  it('should create different UMKs for different users', async () => {
    let result1 = await authService.register('multi1@example.com', 'securepass123');
    let result2 = await authService.register('multi2@example.com', 'securepass123');

    let decoded1 = authService.verifyToken(result1.token);
    let decoded2 = authService.verifyToken(result2.token);

    let umk1 = authService.getUMK(decoded1);
    let umk2 = authService.getUMK(decoded2);

    assert.notDeepEqual(umk1, umk2);
  });
});

// =============================================================================
// Per-user key derivation
// =============================================================================

describe('per-user key derivation', () => {
  it('should derive consistent per-user keys from UMK', async () => {
    let result  = await authService.register('derive@example.com', 'securepass123');
    let decoded = authService.verifyToken(result.token);
    let umk     = authService.getUMK(decoded);

    let userKey1 = keystore.deriveUserKey(umk, result.user.id);
    let userKey2 = keystore.deriveUserKey(umk, result.user.id);

    assert.deepEqual(userKey1, userKey2);
    assert.equal(userKey1.length, 32);
  });

  it('should derive different keys for different users', async () => {
    let result1 = await authService.register('derive1@example.com', 'securepass123');
    let result2 = await authService.register('derive2@example.com', 'securepass123');

    let decoded1 = authService.verifyToken(result1.token);
    let decoded2 = authService.verifyToken(result2.token);

    let umk1 = authService.getUMK(decoded1);
    let umk2 = authService.getUMK(decoded2);

    let userKey1 = keystore.deriveUserKey(umk1, result1.user.id);
    let userKey2 = keystore.deriveUserKey(umk2, result2.user.id);

    assert.notDeepEqual(userKey1, userKey2);
  });
});

// =============================================================================
// AuthError class
// =============================================================================

describe('AuthError', () => {
  it('should be an instance of Error', () => {
    let err = new AuthError('test');
    assert.ok(err instanceof Error);
  });

  it('should have name set to AuthError', () => {
    let err = new AuthError('test');
    assert.equal(err.name, 'AuthError');
  });

  it('should accept a code', () => {
    let err = new AuthError('test', 'CUSTOM_CODE');
    assert.equal(err.code, 'CUSTOM_CODE');
  });

  it('should default code to AUTH_ERROR', () => {
    let err = new AuthError('test');
    assert.equal(err.code, 'AUTH_ERROR');
  });
});
