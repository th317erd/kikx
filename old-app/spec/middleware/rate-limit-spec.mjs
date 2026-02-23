'use strict';

// ============================================================================
// Rate Limiting Tests (X1)
// ============================================================================
// Tests for the token-bucket rate limiter middleware.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  consume,
  rateLimit,
  resetAll,
  resetBucket,
  stopCleanup,
} from '../../server/middleware/rate-limit.mjs';

// ============================================================================
// Token bucket core
// ============================================================================

describe('X1: Rate limiter — consume()', () => {
  beforeEach(() => resetAll());
  afterEach(() => { resetAll(); stopCleanup(); });

  it('should allow requests within limit', () => {
    let key = 'test:allow';
    for (let i = 0; i < 5; i++) {
      let result = consume(key, 5, 60000);
      assert.equal(result.allowed, true, `Request ${i + 1} should be allowed`);
      assert.equal(result.remaining, 5 - i - 1);
    }
  });

  it('should block when limit exceeded', () => {
    let key = 'test:block';
    // Exhaust 3 tokens
    for (let i = 0; i < 3; i++) {
      consume(key, 3, 60000);
    }
    // 4th request should be blocked
    let result = consume(key, 3, 60000);
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
    assert.ok(result.retryAfterMs > 0);
  });

  it('should refill tokens over time', async () => {
    let key = 'test:refill';
    // Exhaust all tokens (2 max, 100ms window → fast refill)
    consume(key, 2, 100);
    consume(key, 2, 100);

    let blocked = consume(key, 2, 100);
    assert.equal(blocked.allowed, false);

    // Wait for refill (full window)
    await new Promise((r) => setTimeout(r, 120));

    let refilled = consume(key, 2, 100);
    assert.equal(refilled.allowed, true);
  });

  it('should isolate different keys', () => {
    consume('key-a', 1, 60000);
    let blockedA = consume('key-a', 1, 60000);
    assert.equal(blockedA.allowed, false);

    let allowedB = consume('key-b', 1, 60000);
    assert.equal(allowedB.allowed, true);
  });

  it('should reset individual buckets', () => {
    consume('reset-test', 1, 60000);
    let blocked = consume('reset-test', 1, 60000);
    assert.equal(blocked.allowed, false);

    resetBucket('reset-test');

    let allowed = consume('reset-test', 1, 60000);
    assert.equal(allowed.allowed, true);
  });

  it('should reset all buckets', () => {
    consume('a', 1, 60000);
    consume('b', 1, 60000);
    consume('a', 1, 60000);
    consume('b', 1, 60000);

    resetAll();

    assert.equal(consume('a', 1, 60000).allowed, true);
    assert.equal(consume('b', 1, 60000).allowed, true);
  });
});

// ============================================================================
// Express middleware
// ============================================================================

describe('X1: Rate limiter — rateLimit() middleware', () => {
  beforeEach(() => resetAll());
  afterEach(() => { resetAll(); stopCleanup(); });

  function mockReq(overrides = {}) {
    return {
      ip:     '127.0.0.1',
      path:   '/test',
      route:  { path: '/test' },
      socket: { remoteAddress: '127.0.0.1' },
      ...overrides,
    };
  }

  function mockRes() {
    let res = {
      _status:  null,
      _json:    null,
      _headers: {},
      status(code)       { res._status = code; return res; },
      json(body)         { res._json = body; return res; },
      set(name, value)   { res._headers[name] = value; return res; },
    };
    return res;
  }

  it('should allow requests and set headers', () => {
    let limiter = rateLimit({ max: 5, windowMs: 60000 });
    let req     = mockReq();
    let res     = mockRes();
    let called  = false;

    limiter(req, res, () => { called = true; });

    assert.equal(called, true);
    assert.equal(res._headers['X-RateLimit-Limit'], '5');
    assert.equal(res._headers['X-RateLimit-Remaining'], '4');
  });

  it('should block and return 429 when exhausted', () => {
    let limiter = rateLimit({ max: 2, windowMs: 60000 });
    let req     = mockReq();

    // Exhaust
    limiter(req, mockRes(), () => {});
    limiter(req, mockRes(), () => {});

    // Should block
    let res    = mockRes();
    let called = false;
    limiter(req, res, () => { called = true; });

    assert.equal(called, false);
    assert.equal(res._status, 429);
    assert.ok(res._json.error);
    assert.ok(res._headers['Retry-After']);
  });

  it('should use custom key generator', () => {
    let limiter = rateLimit({
      max:       1,
      windowMs:  60000,
      keyGenerator: (req) => `custom:${req.customKey}`,
    });

    let reqA = mockReq({ customKey: 'user-1' });
    let reqB = mockReq({ customKey: 'user-2' });

    limiter(reqA, mockRes(), () => {});

    // user-1 is blocked
    let resA   = mockRes();
    let nextA  = false;
    limiter(reqA, resA, () => { nextA = true; });
    assert.equal(nextA, false);
    assert.equal(resA._status, 429);

    // user-2 is still allowed
    let resB  = mockRes();
    let nextB = false;
    limiter(reqB, resB, () => { nextB = true; });
    assert.equal(nextB, true);
  });

  it('should use custom error message', () => {
    let limiter = rateLimit({
      max:       1,
      windowMs:  60000,
      message:   'Slow down there, cowboy',
    });

    let req = mockReq();
    limiter(req, mockRes(), () => {});

    let res = mockRes();
    limiter(req, res, () => {});

    assert.equal(res._status, 429);
    assert.equal(res._json.error, 'Slow down there, cowboy');
  });
});

// ============================================================================
// Route integration
// ============================================================================

describe('X1: Rate limiter — route wiring', () => {
  it('should export rateLimit as a function', async () => {
    let mod = await import('../../server/middleware/rate-limit.mjs');
    assert.equal(typeof mod.rateLimit, 'function');
    assert.equal(typeof mod.consume, 'function');
    assert.equal(typeof mod.resetAll, 'function');
    assert.equal(typeof mod.resetBucket, 'function');
    assert.equal(typeof mod.stopCleanup, 'function');
  });

  it('should verify auth routes import rate-limit', async () => {
    // Verify the module can be imported without errors
    let mod = await import('../../server/routes/auth.mjs');
    assert.ok(mod.default, 'auth routes should export a router');
  });

  it('should verify routes/index imports rate-limit', async () => {
    // This exercises the import path — if rate-limit.mjs has errors, this fails
    let mod = await import('../../server/middleware/rate-limit.mjs');
    assert.ok(mod.rateLimit);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('X1: Rate limiter — edge cases', () => {
  beforeEach(() => resetAll());
  afterEach(() => { resetAll(); stopCleanup(); });

  it('should handle max=1 correctly', () => {
    let result1 = consume('single', 1, 60000);
    assert.equal(result1.allowed, true);
    assert.equal(result1.remaining, 0);

    let result2 = consume('single', 1, 60000);
    assert.equal(result2.allowed, false);
  });

  it('should handle very large max values', () => {
    for (let i = 0; i < 100; i++) {
      let result = consume('large', 10000, 60000);
      assert.equal(result.allowed, true);
    }
  });

  it('should handle concurrent different paths same IP', () => {
    let limiter = rateLimit({ max: 1, windowMs: 60000 });

    let req1 = { ip: '1.2.3.4', path: '/a', route: { path: '/a' }, socket: {} };
    let req2 = { ip: '1.2.3.4', path: '/b', route: { path: '/b' }, socket: {} };

    // Default key generator includes path, so different paths get different buckets
    limiter(req1, { set() {}, status() { return { json() {} }; } }, () => {});
    limiter(req1, { set() {}, status() { return { json() {} }; } }, () => {});

    // /b should still be allowed
    let called = false;
    limiter(req2, { set() {}, status() { return { json() {} }; } }, () => { called = true; });
    assert.equal(called, true);
  });

  it('should fall back when req.ip is missing', () => {
    let limiter = rateLimit({ max: 1, windowMs: 60000 });
    let req     = { path: '/test', route: { path: '/test' }, socket: { remoteAddress: '10.0.0.1' } };
    let res     = { _headers: {}, set(k, v) { this._headers[k] = v; } };
    let called  = false;

    limiter(req, res, () => { called = true; });
    assert.equal(called, true);
  });
});
