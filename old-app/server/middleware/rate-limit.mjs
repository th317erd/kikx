'use strict';

// ============================================================================
// Rate Limiting Middleware
// ============================================================================
// In-memory sliding window rate limiter for API endpoints.
// Uses a token bucket approach with automatic cleanup.

/**
 * Rate limit storage: Map<bucketKey, { tokens: number, lastRefill: number }>
 * @type {Map<string, { tokens: number, lastRefill: number }>}
 */
const buckets = new Map();

// Cleanup interval — remove expired buckets every 5 minutes
let cleanupInterval = null;

function startCleanup() {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    let now = Date.now();

    for (let [key, bucket] of buckets) {
      // Remove buckets that haven't been touched in over an hour
      if (now - bucket.lastRefill > 3600000) {
        buckets.delete(key);
      }
    }
  }, 300000); // 5 minutes

  // Don't prevent process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

/**
 * Consume a token from a rate limit bucket.
 * Returns true if the request is allowed, false if rate-limited.
 *
 * @param {string} key - Bucket key (e.g., 'login:192.168.1.1')
 * @param {number} maxTokens - Maximum tokens (requests) allowed
 * @param {number} windowMs - Window duration in milliseconds
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
 */
export function consume(key, maxTokens, windowMs) {
  startCleanup();

  let now    = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    // First request — create bucket with one token consumed
    buckets.set(key, { tokens: maxTokens - 1, lastRefill: now });
    return { allowed: true, remaining: maxTokens - 1, retryAfterMs: 0 };
  }

  // Calculate token refill based on elapsed time
  let elapsed      = now - bucket.lastRefill;
  let refillRate   = maxTokens / windowMs; // tokens per ms
  let newTokens    = elapsed * refillRate;
  bucket.tokens    = Math.min(maxTokens, bucket.tokens + newTokens);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    // Rate limited — calculate retry-after
    let deficit      = 1 - bucket.tokens;
    let retryAfterMs = Math.ceil(deficit / refillRate);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  // Consume a token
  bucket.tokens -= 1;
  return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
}

/**
 * Create an Express rate-limiting middleware.
 *
 * @param {Object} options - Configuration
 * @param {number} options.max - Maximum requests allowed in the window
 * @param {number} options.windowMs - Window duration in milliseconds
 * @param {Function} [options.keyGenerator] - Function(req) => string for bucket key
 * @param {string} [options.message] - Error message when rate-limited
 * @returns {Function} Express middleware
 */
export function rateLimit({ max, windowMs, keyGenerator, message }) {
  let defaultMessage = message || 'Too many requests, please try again later';

  let getKey = keyGenerator || ((req) => {
    // Default: key by IP + route path
    let ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `${req.route?.path || req.path}:${ip}`;
  });

  return (req, res, next) => {
    let key    = getKey(req);
    let result = consume(key, max, windowMs);

    // Set standard rate limit headers
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      let retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: defaultMessage });
    }

    next();
  };
}

/**
 * Reset a specific rate limit bucket (for testing).
 *
 * @param {string} key - Bucket key to reset
 */
export function resetBucket(key) {
  buckets.delete(key);
}

/**
 * Clear all rate limit buckets (for testing).
 */
export function resetAll() {
  buckets.clear();
}

/**
 * Stop the cleanup interval (for testing / graceful shutdown).
 */
export function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export default {
  rateLimit,
  consume,
  resetBucket,
  resetAll,
  stopCleanup,
};
