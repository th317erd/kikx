'use strict';

import { Router } from 'express';
import { authenticateUser, generateToken } from '../auth.mjs';
import { optionalAuth } from '../middleware/auth.mjs';
import { rateLimit } from '../middleware/rate-limit.mjs';
import { audit, AuditEvent } from '../lib/audit.mjs';
import config from '../config.mjs';

const router = Router();

// Rate limit: 10 login attempts per minute per IP
const loginLimiter = rateLimit({
  max:       10,
  windowMs:  60 * 1000,
  keyGenerator: (req) => `login:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
  message:   'Too many login attempts, please try again later',
});

/**
 * POST /api/login
 * Authenticate user and set JWT cookie.
 */
router.post('/login', loginLimiter, async (req, res) => {
  let { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  try {
    let user = await authenticateUser(username, password);

    if (!user) {
      audit(AuditEvent.LOGIN_FAILURE, { username, ip: req.ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    audit(AuditEvent.LOGIN_SUCCESS, { userId: user.id, username: user.username, ip: req.ip });
    let token = generateToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure:   true,
      sameSite: 'strict',
      path:     config.basePath,
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    });

    // Return token in body so client can store in localStorage for WebSocket
    return res.json({
      success: true,
      token,
      user:    {
        id:       user.id,
        username: user.username,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/logout
 * Clear JWT cookie.
 */
router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: config.basePath });
  return res.json({ success: true });
});

/**
 * GET /api/me
 * Get current user info (requires auth).
 */
router.get('/me', optionalAuth, (req, res) => {
  if (!req.user)
    return res.status(401).json({ error: 'Not authenticated' });

  return res.json({
    id:       req.user.id,
    username: req.user.username,
  });
});

export default router;
