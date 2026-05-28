'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM } from './jsdom-helper.mjs';

describe('api.mjs — auth persistence', () => {
  let api;

  beforeEach(async () => {
    setupDOM();

    // Fresh import each time (clear module state)
    // We can't truly re-import in the same process, so we'll test the module as-is
    api = await import('../../src/client/lib/api.mjs');
  });

  afterEach(() => {
    try { localStorage.clear(); } catch (_e) { /* ignore */ }
    teardownDOM();
  });

  // ===========================================================================
  // persistAuth
  // ===========================================================================

  describe('persistAuth', () => {
    it('should save token and user to localStorage', () => {
      let user = { id: '1', email: 'test@example.com' };
      api.persistAuth('jwt-token-123', user);

      let stored = JSON.parse(localStorage.getItem('kikx_auth'));
      assert.equal(stored.token, 'jwt-token-123');
      assert.deepStrictEqual(stored.user, user);
    });

    it('should overwrite previously persisted auth', () => {
      api.persistAuth('old-token', { id: '1' });
      api.persistAuth('new-token', { id: '2' });

      let stored = JSON.parse(localStorage.getItem('kikx_auth'));
      assert.equal(stored.token, 'new-token');
      assert.equal(stored.user.id, '2');
    });
  });

  // ===========================================================================
  // loadPersistedAuth
  // ===========================================================================

  describe('loadPersistedAuth', () => {
    it('should return null when nothing is stored', () => {
      let result = api.loadPersistedAuth();
      assert.equal(result, null);
    });

    it('should return stored token and user', () => {
      let user = { id: '1', email: 'test@example.com' };
      localStorage.setItem('kikx_auth', JSON.stringify({ token: 'abc', user }));

      let result = api.loadPersistedAuth();
      assert.equal(result.token, 'abc');
      assert.deepStrictEqual(result.user, user);
    });

    it('should return null for corrupted JSON', () => {
      localStorage.setItem('kikx_auth', '{bad json}');

      let result = api.loadPersistedAuth();
      assert.equal(result, null);
    });

    it('should return null when stored data has no token', () => {
      localStorage.setItem('kikx_auth', JSON.stringify({ user: { id: '1' } }));

      let result = api.loadPersistedAuth();
      assert.equal(result, null);
    });
  });

  // ===========================================================================
  // clearPersistedAuth
  // ===========================================================================

  describe('clearPersistedAuth', () => {
    it('should remove persisted auth from localStorage', () => {
      localStorage.setItem('kikx_auth', JSON.stringify({ token: 'abc' }));
      api.clearPersistedAuth();

      assert.equal(localStorage.getItem('kikx_auth'), null);
    });

    it('should not throw when no auth is persisted', () => {
      assert.doesNotThrow(() => api.clearPersistedAuth());
    });
  });

  // ===========================================================================
  // setAuthToken / getAuthToken
  // ===========================================================================

  describe('setAuthToken / getAuthToken', () => {
    it('should store and retrieve the auth token', () => {
      api.setAuthToken('my-jwt');
      assert.equal(api.getAuthToken(), 'my-jwt');
    });

    it('should overwrite a previous token', () => {
      api.setAuthToken('first');
      api.setAuthToken('second');
      assert.equal(api.getAuthToken(), 'second');
    });
  });

  // ===========================================================================
  // setOnUnauthorized
  // ===========================================================================

  describe('setOnUnauthorized', () => {
    it('should accept a callback function', () => {
      assert.doesNotThrow(() => api.setOnUnauthorized(() => {}));
    });
  });
});
