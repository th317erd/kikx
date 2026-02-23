'use strict';

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { rateLimit } from '../middleware/rate-limit.mjs';
import { getDatabase } from '../database.mjs';
import { changePassword, getUserById } from '../auth.mjs';
import { createApiKey, listApiKeys, revokeApiKey } from '../lib/auth/api-keys.mjs';
import { generateMagicLink, verifyMagicLink, sendEmail } from '../lib/auth/magic-links.mjs';
import { authenticateUser, generateToken } from '../auth.mjs';
import { audit, AuditEvent } from '../lib/audit.mjs';
import config from '../config.mjs';

const router = Router();

// Rate limit: 5 magic link requests per hour per email
const magicLinkLimiter = rateLimit({
  max:       5,
  windowMs:  60 * 60 * 1000,
  keyGenerator: (req) => `magic-link:${(req.body.email || 'unknown').toLowerCase().trim()}`,
  message:   'Too many magic link requests, please try again later',
});

// Rate limit: 10 API key creations per hour per user
const apiKeyLimiter = rateLimit({
  max:       10,
  windowMs:  60 * 60 * 1000,
  keyGenerator: (req) => `api-key-create:${req.user?.id || 'unknown'}`,
  message:   'Too many API key creations, please try again later',
});

// ============================================================================
// User Profile
// ============================================================================

/**
 * GET /api/users/me/profile
 * Get the current user's profile with usage stats.
 */
router.get('/me/profile', requireAuth, (req, res) => {
  let db   = getDatabase();
  let user = db.prepare(`
    SELECT id, username, email, display_name, created_at, updated_at
    FROM users WHERE id = ?
  `).get(req.user.id);

  if (!user)
    return res.status(404).json({ error: 'User not found' });

  // Aggregate usage stats from token_charges (join through agents for user_id)
  let usage = db.prepare(`
    SELECT
      COALESCE(SUM(tc.input_tokens), 0)  AS totalInputTokens,
      COALESCE(SUM(tc.output_tokens), 0) AS totalOutputTokens,
      COALESCE(SUM(tc.cost_cents), 0)    AS totalCostCents,
      COUNT(*)                             AS totalCharges
    FROM token_charges tc
    JOIN agents a ON tc.agent_id = a.id
    WHERE a.user_id = ?
  `).get(req.user.id);

  res.json({
    id:          user.id,
    username:    user.username,
    email:       user.email,
    displayName: user.display_name,
    createdAt:   user.created_at,
    updatedAt:   user.updated_at,
    usage:       {
      totalInputTokens:  usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      totalCostCents:    usage.totalCostCents,
      totalCharges:      usage.totalCharges,
    },
  });
});

/**
 * PUT /api/users/me/profile
 * Update the current user's profile fields.
 */
router.put('/me/profile', requireAuth, (req, res) => {
  let db      = getDatabase();
  let updates = {};
  let params  = [];
  let clauses = [];

  if (req.body.displayName !== undefined) {
    let displayName = req.body.displayName;
    if (displayName !== null && typeof displayName !== 'string')
      return res.status(400).json({ error: 'displayName must be a string or null' });

    clauses.push('display_name = ?');
    params.push(displayName ? displayName.trim() : null);
    updates.displayName = displayName ? displayName.trim() : null;
  }

  if (req.body.email !== undefined) {
    let email = req.body.email;
    if (email !== null) {
      if (typeof email !== 'string' || !email.includes('@'))
        return res.status(400).json({ error: 'Invalid email address' });
      email = email.trim().toLowerCase();
    }

    // Check for duplicate email
    if (email) {
      let existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
      if (existing)
        return res.status(409).json({ error: 'Email already in use' });
    }

    clauses.push('email = ?');
    params.push(email);
    updates.email = email;
  }

  if (clauses.length === 0)
    return res.status(400).json({ error: 'No fields to update' });

  clauses.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.user.id);

  db.prepare(`
    UPDATE users SET ${clauses.join(', ')} WHERE id = ?
  `).run(...params);

  // Return updated profile
  let user = db.prepare(`
    SELECT id, username, email, display_name, created_at, updated_at
    FROM users WHERE id = ?
  `).get(req.user.id);

  res.json({
    id:          user.id,
    username:    user.username,
    email:       user.email,
    displayName: user.display_name,
    createdAt:   user.created_at,
    updatedAt:   user.updated_at,
  });
});

/**
 * PUT /api/users/me/password
 * Change the current user's password.
 */
router.put('/me/password', requireAuth, async (req, res) => {
  let { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });

  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });

  try {
    await changePassword(req.user.username, currentPassword, newPassword);

    // Re-authenticate to get a fresh token with re-encrypted secret
    let user = await authenticateUser(req.user.username, newPassword);
    if (!user)
      return res.status(500).json({ error: 'Password changed but re-authentication failed' });

    let token = generateToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure:   true,
      sameSite: 'strict',
      path:     config.basePath,
      maxAge:   30 * 24 * 60 * 60 * 1000,
    });

    res.json({ success: true, token });
  } catch (error) {
    if (error.message.includes('Invalid current password'))
      return res.status(401).json({ error: 'Invalid current password' });

    console.error('Password change error:', error);
    return res.status(500).json({ error: 'Password change failed' });
  }
});

// ============================================================================
// API Keys
// ============================================================================

/**
 * GET /api/users/me/api-keys
 * List all API keys for the current user.
 */
router.get('/me/api-keys', requireAuth, (req, res) => {
  let keys = listApiKeys(req.user.id);
  res.json({ keys });
});

/**
 * POST /api/users/me/api-keys
 * Create a new API key. Returns the plaintext key exactly once.
 */
router.post('/me/api-keys', requireAuth, apiKeyLimiter, (req, res) => {
  let { name, scopes, expiresAt } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0)
    return res.status(400).json({ error: 'API key name is required' });

  try {
    let result = createApiKey(req.user.id, name, { scopes, expiresAt });
    audit(AuditEvent.API_KEY_CREATE, { userId: req.user.id, keyId: result.id, name, scopes: scopes || [] });
    res.status(201).json(result);
  } catch (error) {
    console.error('API key creation error:', error);
    return res.status(500).json({ error: 'Failed to create API key' });
  }
});

/**
 * DELETE /api/users/me/api-keys/:id
 * Revoke an API key.
 */
router.delete('/me/api-keys/:id', requireAuth, (req, res) => {
  let keyId   = parseInt(req.params.id, 10);
  let deleted = revokeApiKey(req.user.id, keyId);

  if (!deleted)
    return res.status(404).json({ error: 'API key not found' });

  audit(AuditEvent.API_KEY_REVOKE, { userId: req.user.id, keyId });
  res.json({ success: true });
});

// ============================================================================
// Magic Link Auth
// ============================================================================

/**
 * POST /api/users/auth/magic-link/request
 * Request a magic link for passwordless login.
 */
router.post('/auth/magic-link/request', magicLinkLimiter, (req, res) => {
  let { email } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@'))
    return res.status(400).json({ error: 'Valid email address required' });

  try {
    let { token, expiresAt } = generateMagicLink(email);
    let verifyUrl = `${config.baseUrl}api/users/auth/magic-link/verify?token=${token}`;

    sendEmail(
      email,
      'Hero — Magic Link Login',
      `Click the link below to log in:\n\n${verifyUrl}\n\nThis link expires at ${expiresAt}.`,
    );

    res.json({ success: true, message: 'Magic link sent', expiresAt });
  } catch (error) {
    console.error('Magic link request error:', error);
    return res.status(500).json({ error: 'Failed to generate magic link' });
  }
});

/**
 * GET /api/users/auth/magic-link/verify
 * Verify a magic link token and issue a session.
 */
router.get('/auth/magic-link/verify', (req, res) => {
  let { token } = req.query;

  if (!token)
    return res.status(400).json({ error: 'Token is required' });

  let result = verifyMagicLink(token);

  if (!result)
    return res.status(401).json({ error: 'Invalid, expired, or already used token' });

  if (!result.userId)
    return res.status(404).json({ error: 'No user account associated with this email. Please register first.' });

  // Issue JWT session
  let user = getUserById(result.userId);
  if (!user)
    return res.status(404).json({ error: 'User not found' });

  // For magic link auth, we generate a token without the decrypted secret
  // (since we don't have the password to decrypt it). This token has limited
  // capabilities — it can't decrypt agent API keys.
  let jwt = generateToken({
    id:       user.id,
    username: user.username,
    secret:   null, // No decrypted secret — limited session
  });

  res.cookie('token', jwt, {
    httpOnly: true,
    secure:   true,
    sameSite: 'strict',
    path:     config.basePath,
    maxAge:   30 * 24 * 60 * 60 * 1000,
  });

  res.json({
    success: true,
    token:   jwt,
    user:    { id: user.id, username: user.username },
    limited: true, // Indicates this session can't decrypt agent keys
  });
});

export default router;
