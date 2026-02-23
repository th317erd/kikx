'use strict';

// ============================================================================
// Search API Routes
// ============================================================================
// Cross-session frame content search.

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { getDatabase } from '../database.mjs';
import {
  searchFrames,
  countSearchResults,
} from '../lib/frames/index.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/search
 * Search frame content across sessions.
 *
 * Query parameters:
 * - query: Search text (required, min 2 chars)
 * - sessionId: Limit to specific session (optional)
 * - types: Comma-separated frame types to search (default: 'message')
 * - limit: Max results (default: 50, max: 200)
 * - offset: Pagination offset (default: 0)
 */
router.get('/', (req, res) => {
  let query = req.query.query;

  if (!query || query.trim().length === 0)
    return res.status(400).json({ error: 'Query parameter is required' });

  if (query.trim().length < 2)
    return res.status(400).json({ error: 'Query must be at least 2 characters' });

  query = query.trim();

  let options = {};

  if (req.query.sessionId) {
    options.sessionId = parseInt(req.query.sessionId, 10);

    // Verify session belongs to user
    let db      = getDatabase();
    let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
      .get(options.sessionId, req.user.id);

    if (!session)
      return res.status(404).json({ error: 'Session not found' });
  }

  if (req.query.types)
    options.types = req.query.types.split(',').map((t) => t.trim());

  if (req.query.limit)
    options.limit = parseInt(req.query.limit, 10);

  if (req.query.offset)
    options.offset = parseInt(req.query.offset, 10);

  let results = searchFrames(req.user.id, query, options);
  let total   = countSearchResults(req.user.id, query, options);

  res.json({
    results,
    total,
    query,
    hasMore: (options.offset || 0) + results.length < total,
  });
});

export default router;
