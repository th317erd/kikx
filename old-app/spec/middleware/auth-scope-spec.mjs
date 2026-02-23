'use strict';

// ============================================================================
// F6: API Key Scope Enforcement Tests (GUARD-009)
// ============================================================================
// Tests for checkApiKeyScopes() and scope enforcement in requireAuth middleware.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkApiKeyScopes, SCOPE_MAP } from '../../server/middleware/auth.mjs';

// ============================================================================
// GUARD-009: checkApiKeyScopes() — pure function tests
// ============================================================================

describe('F6: checkApiKeyScopes()', () => {

  // --------------------------------------------------------------------------
  // Empty / null scopes = full access
  // --------------------------------------------------------------------------

  describe('empty scopes (full access)', () => {
    it('should allow any request when scopes is empty array', () => {
      assert.equal(checkApiKeyScopes([], 'GET', '/api/sessions'), true);
      assert.equal(checkApiKeyScopes([], 'POST', '/api/agents'), true);
      assert.equal(checkApiKeyScopes([], 'DELETE', '/api/permissions/1'), true);
    });

    it('should allow any request when scopes is null', () => {
      assert.equal(checkApiKeyScopes(null, 'GET', '/api/sessions'), true);
      assert.equal(checkApiKeyScopes(null, 'POST', '/api/agents'), true);
    });

    it('should allow any request when scopes is undefined', () => {
      assert.equal(checkApiKeyScopes(undefined, 'GET', '/api/users/me'), true);
    });
  });

  // --------------------------------------------------------------------------
  // Sessions scope
  // --------------------------------------------------------------------------

  describe('sessions scopes', () => {
    it('should allow GET /api/sessions with read:sessions scope', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'GET', '/api/sessions'), true);
    });

    it('should deny GET /api/sessions without read:sessions scope', () => {
      assert.equal(checkApiKeyScopes(['write:sessions'], 'GET', '/api/sessions'), false);
    });

    it('should allow POST /api/sessions with write:sessions scope', () => {
      assert.equal(checkApiKeyScopes(['write:sessions'], 'POST', '/api/sessions'), true);
    });

    it('should deny POST /api/sessions without write:sessions scope', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'POST', '/api/sessions'), false);
    });

    it('should allow PUT /api/sessions/1 with write:sessions scope', () => {
      assert.equal(checkApiKeyScopes(['write:sessions'], 'PUT', '/api/sessions/1'), true);
    });

    it('should allow DELETE /api/sessions/1 with write:sessions scope', () => {
      assert.equal(checkApiKeyScopes(['write:sessions'], 'DELETE', '/api/sessions/1'), true);
    });

    it('should allow nested session paths', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'GET', '/api/sessions/5/messages'), true);
      assert.equal(checkApiKeyScopes(['write:sessions'], 'POST', '/api/sessions/5/messages/stream'), true);
    });
  });

  // --------------------------------------------------------------------------
  // Agents scope
  // --------------------------------------------------------------------------

  describe('agents scopes', () => {
    it('should allow GET /api/agents with read:agents scope', () => {
      assert.equal(checkApiKeyScopes(['read:agents'], 'GET', '/api/agents'), true);
    });

    it('should deny GET /api/agents without read:agents scope', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'GET', '/api/agents'), false);
    });

    it('should allow POST /api/agents with write:agents scope', () => {
      assert.equal(checkApiKeyScopes(['write:agents'], 'POST', '/api/agents'), true);
    });

    it('should deny PUT /api/agents/1 without write:agents scope', () => {
      assert.equal(checkApiKeyScopes(['read:agents'], 'PUT', '/api/agents/1'), false);
    });

    it('should allow DELETE /api/agents/1 with write:agents scope', () => {
      assert.equal(checkApiKeyScopes(['write:agents'], 'DELETE', '/api/agents/1'), true);
    });
  });

  // --------------------------------------------------------------------------
  // Permissions scope
  // --------------------------------------------------------------------------

  describe('permissions scopes', () => {
    it('should allow GET /api/permissions with read:permissions scope', () => {
      assert.equal(checkApiKeyScopes(['read:permissions'], 'GET', '/api/permissions'), true);
    });

    it('should allow POST /api/permissions with write:permissions scope', () => {
      assert.equal(checkApiKeyScopes(['write:permissions'], 'POST', '/api/permissions'), true);
    });

    it('should deny DELETE /api/permissions/1 without write:permissions scope', () => {
      assert.equal(checkApiKeyScopes(['read:permissions'], 'DELETE', '/api/permissions/1'), false);
    });
  });

  // --------------------------------------------------------------------------
  // Users / profile scope
  // --------------------------------------------------------------------------

  describe('users/profile scopes', () => {
    it('should allow GET /api/users/me with read:profile scope', () => {
      assert.equal(checkApiKeyScopes(['read:profile'], 'GET', '/api/users/me'), true);
    });

    it('should allow PUT /api/users/me/profile with write:profile scope', () => {
      assert.equal(checkApiKeyScopes(['write:profile'], 'PUT', '/api/users/me/profile'), true);
    });

    it('should deny GET /api/users/me without read:profile scope', () => {
      assert.equal(checkApiKeyScopes(['write:profile'], 'GET', '/api/users/me'), false);
    });

    it('should deny PUT /api/users/me without write:profile scope', () => {
      assert.equal(checkApiKeyScopes(['read:profile'], 'PUT', '/api/users/me'), false);
    });
  });

  // --------------------------------------------------------------------------
  // Multiple scopes
  // --------------------------------------------------------------------------

  describe('multiple scopes', () => {
    it('should allow when key has the required scope among many', () => {
      let scopes = ['read:sessions', 'write:agents', 'read:profile'];
      assert.equal(checkApiKeyScopes(scopes, 'GET', '/api/sessions'), true);
      assert.equal(checkApiKeyScopes(scopes, 'POST', '/api/agents'), true);
      assert.equal(checkApiKeyScopes(scopes, 'GET', '/api/users/me'), true);
    });

    it('should deny when key lacks the required scope', () => {
      let scopes = ['read:sessions', 'read:agents'];
      assert.equal(checkApiKeyScopes(scopes, 'POST', '/api/sessions'), false);   // needs write:sessions
      assert.equal(checkApiKeyScopes(scopes, 'DELETE', '/api/agents/1'), false);  // needs write:agents
    });
  });

  // --------------------------------------------------------------------------
  // Unscoped endpoints (no matching rule = allow)
  // --------------------------------------------------------------------------

  describe('unscoped endpoints', () => {
    it('should allow /api/health even with scoped key', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'GET', '/api/health'), true);
    });

    it('should allow /api/help even with scoped key', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'GET', '/api/help'), true);
    });

    it('should allow /api/commands even with scoped key', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'GET', '/api/commands'), true);
    });

    it('should allow /api/search even with scoped key', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'GET', '/api/search?q=test'), true);
    });

    it('should allow PATCH method (not in scope map) on any path', () => {
      assert.equal(checkApiKeyScopes(['read:sessions'], 'PATCH', '/api/sessions/1'), true);
    });
  });
});

// ============================================================================
// SCOPE_MAP structure validation
// ============================================================================

describe('F6: SCOPE_MAP structure', () => {
  it('should be an array of rule objects', () => {
    assert.ok(Array.isArray(SCOPE_MAP));
    assert.ok(SCOPE_MAP.length > 0);
  });

  it('should have method, pattern, scope on every entry', () => {
    for (let rule of SCOPE_MAP) {
      assert.ok(typeof rule.method === 'string', `Rule missing method: ${JSON.stringify(rule)}`);
      assert.ok(rule.pattern instanceof RegExp, `Rule missing pattern: ${JSON.stringify(rule)}`);
      assert.ok(typeof rule.scope === 'string', `Rule missing scope: ${JSON.stringify(rule)}`);
    }
  });

  it('should cover all four resource types', () => {
    let scopes = SCOPE_MAP.map((r) => r.scope);
    assert.ok(scopes.some((s) => s.includes('sessions')), 'Should have sessions scopes');
    assert.ok(scopes.some((s) => s.includes('agents')), 'Should have agents scopes');
    assert.ok(scopes.some((s) => s.includes('permissions')), 'Should have permissions scopes');
    assert.ok(scopes.some((s) => s.includes('profile')), 'Should have profile scopes');
  });

  it('should have read and write variants for each resource', () => {
    let resources = ['sessions', 'agents', 'permissions', 'profile'];
    for (let resource of resources) {
      let resourceScopes = SCOPE_MAP.filter((r) => r.scope.includes(resource));
      let readScopes  = resourceScopes.filter((r) => r.scope.startsWith('read:'));
      let writeScopes = resourceScopes.filter((r) => r.scope.startsWith('write:'));
      assert.ok(readScopes.length > 0, `Missing read scope for ${resource}`);
      assert.ok(writeScopes.length > 0, `Missing write scope for ${resource}`);
    }
  });

  it('should use valid HTTP methods only', () => {
    let validMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
    for (let rule of SCOPE_MAP) {
      assert.ok(validMethods.has(rule.method), `Invalid HTTP method: ${rule.method}`);
    }
  });
});

// ============================================================================
// Middleware integration (structural verification)
// ============================================================================

describe('F6: requireAuth scope enforcement wiring', () => {
  it('should import requireAuth from auth middleware', async () => {
    let mod = await import('../../server/middleware/auth.mjs');
    assert.equal(typeof mod.requireAuth, 'function');
  });

  it('should export checkApiKeyScopes as named export', async () => {
    let mod = await import('../../server/middleware/auth.mjs');
    assert.equal(typeof mod.checkApiKeyScopes, 'function');
  });

  it('should export SCOPE_MAP as named export', async () => {
    let mod = await import('../../server/middleware/auth.mjs');
    assert.ok(Array.isArray(mod.SCOPE_MAP));
  });

  it('should include checkApiKeyScopes in default export', async () => {
    let mod = await import('../../server/middleware/auth.mjs');
    assert.equal(typeof mod.default.checkApiKeyScopes, 'function');
  });

  it('should include SCOPE_MAP in default export', async () => {
    let mod = await import('../../server/middleware/auth.mjs');
    assert.ok(Array.isArray(mod.default.SCOPE_MAP));
  });
});
