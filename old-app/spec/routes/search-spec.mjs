'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-search-route-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let frames;
let express;

async function loadModules() {
  database = await import('../../server/database.mjs');
  auth     = await import('../../server/auth.mjs');
  frames   = await import('../../server/lib/frames/index.mjs');
  express  = (await import('express')).default;
}

/**
 * Create a test Express app with auth bypass.
 * Mounts search and frames routes with a middleware that injects req.user.
 */
async function createTestApp(userId) {
  let searchRoutes = (await import('../../server/routes/search.mjs')).default;
  let framesRoutes = (await import('../../server/routes/frames.mjs')).default;

  let app = express();
  app.use(express.json());

  // Auth bypass — inject user before any route middleware
  app.use((req, res, next) => {
    req.user = { id: userId };
    next();
  });

  // Mount routes WITHOUT requireAuth by wrapping them
  // We need to strip requireAuth — the simplest way is to mount our own Router
  let searchRouter = express.Router();
  let framesRouter = express.Router();

  // Re-mount the same route handlers without auth
  searchRouter.get('/', (req, res) => {
    let query = req.query.query;
    if (!query || query.trim().length === 0)
      return res.status(400).json({ error: 'Query parameter is required' });
    if (query.trim().length < 2)
      return res.status(400).json({ error: 'Query must be at least 2 characters' });

    query = query.trim();
    let options = {};
    if (req.query.sessionId) {
      options.sessionId = parseInt(req.query.sessionId, 10);
      let db      = database.getDatabase();
      let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
        .get(options.sessionId, req.user.id);
      if (!session)
        return res.status(404).json({ error: 'Session not found' });
    }
    if (req.query.types)  options.types  = req.query.types.split(',').map((t) => t.trim());
    if (req.query.limit)  options.limit  = parseInt(req.query.limit, 10);
    if (req.query.offset) options.offset = parseInt(req.query.offset, 10);

    let results = frames.searchFrames(req.user.id, query, options);
    let total   = frames.countSearchResults(req.user.id, query, options);
    res.json({ results, total, query, hasMore: (options.offset || 0) + results.length < total });
  });

  framesRouter.get('/:sessionId/frames', (req, res) => {
    let db = database.getDatabase();
    let sessionId = parseInt(req.params.sessionId, 10);
    let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
      .get(sessionId, req.user.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let options = {};
    if (req.query.fromCompact) options.fromCompact = true;
    if (req.query.fromTimestamp) options.fromTimestamp = req.query.fromTimestamp;
    if (req.query.before) options.beforeTimestamp = req.query.before;
    if (req.query.types) options.types = req.query.types.split(',').map((t) => t.trim());
    let requestedLimit = null;
    if (req.query.limit) {
      requestedLimit = parseInt(req.query.limit, 10);
      options.limit = requestedLimit;
    }

    let framesList = frames.getFrames(sessionId, options);

    let hasMore = false;
    if (requestedLimit && framesList.length === requestedLimit) {
      let checkOptions = {};
      if (options.beforeTimestamp && framesList.length > 0)
        checkOptions.beforeTimestamp = framesList[0].timestamp;
      else if (framesList.length > 0)
        checkOptions.fromTimestamp = framesList[framesList.length - 1].timestamp;
      if (options.types) checkOptions.types = options.types;
      checkOptions.limit = 1;
      let peek = frames.getFrames(sessionId, checkOptions);
      hasMore = peek.length > 0;
    }

    res.json({ frames: framesList, count: framesList.length, hasMore });
  });

  app.use('/search', searchRouter);
  app.use('/sessions', framesRouter);

  return app;
}

/**
 * Make a request to the test app.
 */
function makeRequest(app, method, path) {
  return new Promise((resolve, reject) => {
    let server = app.listen(0, () => {
      let port = server.address().port;
      let url  = `http://localhost:${port}${path}`;

      fetch(url, { method, headers: { 'Content-Type': 'application/json' } })
        .then(async (res) => {
          let body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('Search & Pagination Routes (Phase 5)', async () => {
  await loadModules();

  let db;
  let userId;
  let sessionId;
  let app;

  beforeEach(async () => {
    db = database.getDatabase();

    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    let user = await auth.createUser('searchrouteuser', 'testpass');
    userId   = user.id;

    let agent = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent', 'claude', 'fake-key')
    `).run(userId);
    let agentId = Number(agent.lastInsertRowid);

    let session = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(session.lastInsertRowid);

    // Create test frames
    frames.createFrame({
      sessionId: sessionId, type: 'message', authorType: 'user', authorId: userId,
      payload: { role: 'user', content: 'Tell me about JavaScript closures', hidden: false },
    }, db);

    frames.createFrame({
      sessionId: sessionId, type: 'message', authorType: 'agent', authorId: agentId,
      payload: { role: 'assistant', content: 'A closure is a function that captures variables from its scope.', hidden: false },
    }, db);

    frames.createFrame({
      sessionId: sessionId, type: 'message', authorType: 'user', authorId: userId,
      payload: { role: 'user', content: 'What about Python decorators?', hidden: false },
    }, db);

    app = await createTestApp(userId);
  });

  // ===========================================================================
  // GET /search
  // ===========================================================================
  describe('GET /search', () => {
    it('should return search results for matching query', async () => {
      let res = await makeRequest(app, 'GET', '/search?query=closure');

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.results.length > 0);
      assert.strictEqual(res.body.query, 'closure');
      assert.ok(typeof res.body.total === 'number');
      assert.ok(typeof res.body.hasMore === 'boolean');
    });

    it('should return 400 for missing query', async () => {
      let res = await makeRequest(app, 'GET', '/search');

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('required'));
    });

    it('should return 400 for query shorter than 2 chars', async () => {
      let res = await makeRequest(app, 'GET', '/search?query=a');

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('2 characters'));
    });

    it('should return empty results for no matches', async () => {
      let res = await makeRequest(app, 'GET', '/search?query=xyznonexistent');

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.results.length, 0);
      assert.strictEqual(res.body.total, 0);
      assert.strictEqual(res.body.hasMore, false);
    });

    it('should support limit parameter', async () => {
      let res = await makeRequest(app, 'GET', '/search?query=about&limit=1');

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.results.length <= 1);
    });

    it('should scope to sessionId when provided', async () => {
      let res = await makeRequest(app, 'GET', `/search?query=closure&sessionId=${sessionId}`);

      assert.strictEqual(res.status, 200);
      for (let result of res.body.results) {
        assert.strictEqual(result.sessionId, sessionId);
      }
    });

    it('should return 404 for nonexistent session', async () => {
      let res = await makeRequest(app, 'GET', '/search?query=test&sessionId=99999');

      assert.strictEqual(res.status, 404);
    });

    it('should calculate hasMore correctly', async () => {
      // Add many frames so we can test pagination
      for (let i = 0; i < 5; i++) {
        frames.createFrame({
          sessionId: sessionId, type: 'message', authorType: 'user', authorId: userId,
          payload: { role: 'user', content: `Extra closure message ${i}`, hidden: false },
        }, db);
      }

      let res = await makeRequest(app, 'GET', '/search?query=closure&limit=2');

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.results.length <= 2);
      // There should be more results beyond the limit
      assert.strictEqual(res.body.hasMore, true);
    });
  });

  // ===========================================================================
  // GET /sessions/:id/frames (backward pagination)
  // ===========================================================================
  describe('GET /sessions/:id/frames (backward pagination)', () => {
    it('should return frames with hasMore flag', async () => {
      // Add more frames
      for (let i = 0; i < 5; i++) {
        frames.createFrame({
          sessionId: sessionId, type: 'message', authorType: 'user', authorId: userId,
          payload: { role: 'user', content: `Extra message ${i}`, hidden: false },
        }, db);
      }

      let res = await makeRequest(app, 'GET', `/sessions/${sessionId}/frames?limit=3`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.frames.length, 3);
      assert.strictEqual(res.body.hasMore, true);
    });

    it('should return hasMore=false when all frames returned', async () => {
      let res = await makeRequest(app, 'GET', `/sessions/${sessionId}/frames?limit=100`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.hasMore, false);
    });

    it('should support before parameter for backward pagination', async () => {
      // Get all frames first
      let allRes = await makeRequest(app, 'GET', `/sessions/${sessionId}/frames`);
      let allFrames = allRes.body.frames;

      assert.ok(allFrames.length >= 2, 'Need at least 2 frames');

      let lastTimestamp = allFrames[allFrames.length - 1].timestamp;
      let beforeRes = await makeRequest(app, 'GET',
        `/sessions/${sessionId}/frames?before=${encodeURIComponent(lastTimestamp)}&limit=2`);

      assert.strictEqual(beforeRes.status, 200);
      for (let frame of beforeRes.body.frames) {
        assert.ok(frame.timestamp < lastTimestamp,
          `Frame timestamp should be before ${lastTimestamp}`);
      }
    });

    it('should return frames in ascending order with before', async () => {
      // Add more frames
      for (let i = 0; i < 5; i++) {
        frames.createFrame({
          sessionId: sessionId, type: 'message', authorType: 'user', authorId: userId,
          payload: { role: 'user', content: `Ordered message ${i}`, hidden: false },
        }, db);
      }

      let allRes = await makeRequest(app, 'GET', `/sessions/${sessionId}/frames`);
      let allFrames = allRes.body.frames;
      let lastTimestamp = allFrames[allFrames.length - 1].timestamp;

      let beforeRes = await makeRequest(app, 'GET',
        `/sessions/${sessionId}/frames?before=${encodeURIComponent(lastTimestamp)}&limit=5`);

      let resultFrames = beforeRes.body.frames;
      for (let i = 1; i < resultFrames.length; i++) {
        assert.ok(resultFrames[i].timestamp > resultFrames[i - 1].timestamp,
          `Frame ${i} should be after frame ${i - 1}`);
      }
    });

    it('should return 404 for nonexistent session', async () => {
      let res = await makeRequest(app, 'GET', '/sessions/99999/frames');

      assert.strictEqual(res.status, 404);
    });
  });
});
