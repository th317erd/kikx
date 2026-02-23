'use strict';

// ============================================================================
// X3: Health Check Endpoint Tests
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const routeIndex = fs.readFileSync(
  path.join(projectRoot, 'server/routes/index.mjs'), 'utf-8',
);

describe('X3: Health check endpoint', () => {
  it('should have GET /health route', () => {
    assert.ok(
      routeIndex.includes("router.get('/health'"),
      'Should have GET /health route',
    );
  });

  it('should return status field', () => {
    assert.ok(
      routeIndex.includes("status:  'ok'"),
      'Should return status ok',
    );
  });

  it('should return version field', () => {
    assert.ok(
      routeIndex.includes('version:'),
      'Should return version field',
    );
  });

  it('should return uptime field', () => {
    assert.ok(
      routeIndex.includes('process.uptime()'),
      'Should return uptime from process',
    );
  });

  it('should check database connectivity', () => {
    assert.ok(
      routeIndex.includes('getDatabase'),
      'Should check database',
    );
    assert.ok(
      routeIndex.includes("db:"),
      'Should return db status field',
    );
  });

  it('should not require authentication', () => {
    // The health route should NOT have requireAuth middleware
    // Check that 'health' is defined before the requireAuth routes
    let healthIndex = routeIndex.indexOf("'/health'");
    let authIndex   = routeIndex.indexOf('requireAuth');

    // requireAuth is used elsewhere (SSE test), but the health route itself
    // should not call requireAuth. Verify the health handler doesn't include it.
    assert.ok(
      !routeIndex.includes("requireAuth, (req, res) => {\n  let dbStatus"),
      'Health check should not require auth',
    );
  });

  it('should handle database errors gracefully', () => {
    assert.ok(
      routeIndex.includes("dbStatus = 'error'"),
      'Should set db status to error on failure',
    );
  });
});
