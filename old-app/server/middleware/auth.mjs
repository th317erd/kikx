'use strict';

import { verifyToken, getUserById } from '../auth.mjs';
import { validateApiKey } from '../lib/auth/api-keys.mjs';
import { audit, AuditEvent } from '../lib/audit.mjs';
import config from '../config.mjs';

/**
 * Try to authenticate via API key from Authorization header.
 *
 * @param {object} req - Express request
 * @returns {{id: number, username: string, secret: null, authMethod: string} | null}
 */
function authenticateApiKey(req) {
  let authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return null;

  let key    = authHeader.substring(7);
  let result = validateApiKey(key);
  if (!result)
    return null;

  let user = getUserById(result.userId);
  if (!user)
    return null;

  return {
    id:         user.id,
    username:   user.username,
    secret:     null, // API key auth has no decrypted secret
    authMethod: 'api-key',
    apiKey:     { name: result.name, scopes: result.scopes },
  };
}

/**
 * Try to authenticate via JWT cookie.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {{id: number, username: string, secret: object, authMethod: string} | null}
 */
function authenticateJwt(req, res) {
  let token = req.cookies?.token;
  if (!token)
    return null;

  let decoded = verifyToken(token);
  if (!decoded) {
    res.clearCookie('token', { path: config.basePath });
    return null;
  }

  return {
    id:         decoded.sub,
    username:   decoded.username,
    secret:     decoded.secret,
    authMethod: 'jwt',
  };
}

// ============================================================================
// API Key Scope Enforcement
// ============================================================================
// Maps HTTP method + path to required scopes. If an API key has scopes
// defined, the request must match at least one. Empty scopes = full access.

const SCOPE_MAP = [
  // Sessions
  { method: 'GET',    pattern: /^\/api\/sessions/,    scope: 'read:sessions' },
  { method: 'POST',   pattern: /^\/api\/sessions/,    scope: 'write:sessions' },
  { method: 'PUT',    pattern: /^\/api\/sessions/,    scope: 'write:sessions' },
  { method: 'DELETE', pattern: /^\/api\/sessions/,    scope: 'write:sessions' },
  // Agents
  { method: 'GET',    pattern: /^\/api\/agents/,      scope: 'read:agents' },
  { method: 'POST',   pattern: /^\/api\/agents/,      scope: 'write:agents' },
  { method: 'PUT',    pattern: /^\/api\/agents/,      scope: 'write:agents' },
  { method: 'DELETE', pattern: /^\/api\/agents/,      scope: 'write:agents' },
  // Permissions
  { method: 'GET',    pattern: /^\/api\/permissions/,  scope: 'read:permissions' },
  { method: 'POST',   pattern: /^\/api\/permissions/,  scope: 'write:permissions' },
  { method: 'DELETE', pattern: /^\/api\/permissions/,  scope: 'write:permissions' },
  // Users / profile
  { method: 'GET',    pattern: /^\/api\/users/,        scope: 'read:profile' },
  { method: 'PUT',    pattern: /^\/api\/users/,        scope: 'write:profile' },
];

/**
 * Check if an API key's scopes allow the current request.
 *
 * @param {string[]} scopes   - Key's scopes (empty = full access)
 * @param {string}   method   - HTTP method
 * @param {string}   path     - Request path
 * @returns {boolean} True if allowed
 */
function checkApiKeyScopes(scopes, method, path) {
  // Empty scopes = full access (backwards compatible)
  if (!scopes || scopes.length === 0)
    return true;

  // Find matching scope rule
  for (let rule of SCOPE_MAP) {
    if (rule.method === method && rule.pattern.test(path)) {
      return scopes.includes(rule.scope);
    }
  }

  // No matching rule = allow (unscoped endpoints like /health, /help)
  return true;
}

/**
 * Middleware to require authentication.
 * Checks API key (Authorization: Bearer) first, then JWT cookie.
 *
 * For API routes: returns 401 JSON response if not authenticated.
 * For page routes: redirects to login page.
 */
export function requireAuth(req, res, next) {
  // Try API key first
  let apiKeyUser = authenticateApiKey(req);
  if (apiKeyUser) {
    // Enforce scopes if the key has them
    let scopes = apiKeyUser.apiKey?.scopes || [];
    if (!checkApiKeyScopes(scopes, req.method, req.originalUrl || req.path)) {
      audit(AuditEvent.API_KEY_USE, {
        userId:    apiKeyUser.id,
        keyName:   apiKeyUser.apiKey?.name,
        method:    req.method,
        path:      req.originalUrl || req.path,
        ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
        denied:    true,
        reason:    'insufficient_scope',
      });
      return res.status(403).json({
        error: 'Insufficient API key scope for this resource',
      });
    }

    audit(AuditEvent.API_KEY_USE, {
      userId:    apiKeyUser.id,
      keyName:   apiKeyUser.apiKey?.name,
      method:    req.method,
      path:      req.originalUrl || req.path,
      ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
    });

    req.user = apiKeyUser;
    return next();
  }

  // Try JWT cookie
  let jwtUser = authenticateJwt(req, res);
  if (jwtUser) {
    req.user = jwtUser;
    return next();
  }

  // Not authenticated
  if (req.path.startsWith('/api/'))
    return res.status(401).json({ error: 'Authentication required' });

  return res.redirect('/login');
}

/**
 * Middleware to optionally extract auth info without requiring it.
 * If authenticated, attaches user to request. Otherwise, continues.
 */
export function optionalAuth(req, res, next) {
  let apiKeyUser = authenticateApiKey(req);
  if (apiKeyUser) {
    req.user = apiKeyUser;
    return next();
  }

  let token = req.cookies?.token;
  if (token) {
    let decoded = verifyToken(token);
    if (decoded) {
      req.user = {
        id:         decoded.sub,
        username:   decoded.username,
        secret:     decoded.secret,
        authMethod: 'jwt',
      };
    }
  }

  next();
}

/**
 * Get the current user's data key for decryption.
 *
 * @param {object} req - Express request with user attached
 * @returns {string} Hex-encoded data key
 * @throws {Error} If user not authenticated or secret not available
 */
export function getDataKey(req) {
  if (!req.user || !req.user.secret || !req.user.secret.dataKey)
    throw new Error('User not authenticated or secret not available');

  return req.user.secret.dataKey;
}

export { checkApiKeyScopes, SCOPE_MAP };

export default {
  requireAuth,
  optionalAuth,
  getDataKey,
  checkApiKeyScopes,
  SCOPE_MAP,
};
