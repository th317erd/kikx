'use strict';

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { rateLimit } from '../middleware/rate-limit.mjs';

import { getDatabase } from '../database.mjs';
import authRoutes from './auth.mjs';
import agentsRoutes from './agents.mjs';
import sessionsRoutes from './sessions.mjs';
import messagesRoutes from './messages.mjs';
import messagesStreamRoutes from './messages-stream.mjs';
import framesRoutes from './frames.mjs';
import commandsRoutes from './commands.mjs';
import toolsRoutes from './tools.mjs';
import abilitiesRoutes from './abilities.mjs';
import helpRoutes from './help.mjs';
import usageRoutes from './usage.mjs';
import permissionsRoutes from './permissions.mjs';
import searchRoutes from './search.mjs';
import usersRoutes from './users.mjs';
import uploadsRoutes from './uploads.mjs';

const router = Router();

// Global rate limit: 100 requests per minute per IP (applied to all API routes)
const globalLimiter = rateLimit({
  max:       100,
  windowMs:  60 * 1000,
  keyGenerator: (req) => `global:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
  message:   'Too many requests, please try again later',
});

router.use(globalLimiter);

// Auth routes (login/logout don't require auth)
router.use('/', authRoutes);

// Protected routes
router.use('/agents', agentsRoutes);
router.use('/sessions', sessionsRoutes);
router.use('/sessions', messagesRoutes);        // Mounted under /sessions for /sessions/:id/messages
router.use('/sessions', messagesStreamRoutes);  // Streaming endpoint: /sessions/:id/messages/stream
router.use('/sessions', framesRoutes);          // Frames endpoint: /sessions/:id/frames
router.use('/commands', commandsRoutes);
router.use('/tools', toolsRoutes);
router.use('/abilities', abilitiesRoutes);
router.use('/help', helpRoutes);
router.use('/usage', usageRoutes);
router.use('/permissions', permissionsRoutes);
router.use('/search', searchRoutes);
router.use('/users', usersRoutes);
router.use('/uploads', uploadsRoutes);       // File serving: /uploads/:id
router.use('/sessions', uploadsRoutes);      // Upload + list: /sessions/:id/uploads

// Health check — no auth required
router.get('/health', (req, res) => {
  let dbStatus = 'unknown';

  try {
    let db  = getDatabase();
    let row = db.prepare('SELECT 1 AS ok').get();
    dbStatus = (row && row.ok === 1) ? 'ok' : 'error';
  } catch (error) {
    dbStatus = 'error';
  }

  res.json({
    status:  'ok',
    version: '1.0.0',
    uptime:  process.uptime(),
    db:      dbStatus,
  });
});

// SSE test endpoint
router.get('/test-sse', requireAuth, async (req, res) => {
  const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  const debug = (...args) => { if (DEBUG) console.log('[SSE-Test]', ...args); };

  debug('SSE test endpoint called');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.flushHeaders();
  res.write(':ok\n\n');

  // Send 5 events with 1 second delay between each
  for (let i = 1; i <= 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    debug(`SSE test: sending event ${i}`);
    res.write(`event: test\ndata: {"count": ${i}, "message": "Test event ${i}"}\n\n`);
  }

  res.write(`event: done\ndata: {"message": "Test complete"}\n\n`);
  debug('SSE test: complete');
  res.end();
});

export default router;
