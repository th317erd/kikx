'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setAuthToken,
  getAuthToken,
  setOnUnauthorized,
  ApiError,
  registerUser,
  getSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  addParticipant,
  removeParticipant,
  getAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  healthCheck,
} from '../../lib/api.mjs';

// Mock fetch for testing
let fetchCalls = [];
let fetchResponses = [];

function mockFetch(url, options) {
  fetchCalls.push({ url, options });
  let response = fetchResponses.shift() || { ok: true, status: 200, body: {} };
  return Promise.resolve({
    ok: response.ok !== false,
    status: response.status || 200,
    statusText: response.statusText || 'OK',
    headers: { get: (_key) => 'application/json' },
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  });
}

let originalFetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  setAuthToken(null);
  setOnUnauthorized(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('api', () => {
  describe('healthCheck()', () => {
    it('calls GET /kikx/api/v1/health', async () => {
      await healthCheck();
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/health');
      assert.equal(fetchCalls[0].options.method, 'GET');
    });
  });

  describe('auth token', () => {
    it('attaches Bearer token in Authorization header when token is set', async () => {
      setAuthToken('my-token');
      await healthCheck();
      assert.equal(fetchCalls[0].options.headers['Authorization'], 'Bearer my-token');
    });

    it('does not include Authorization header when token is null', async () => {
      setAuthToken(null);
      await healthCheck();
      assert.equal(fetchCalls[0].options.headers['Authorization'], undefined);
    });
  });

  describe('registerUser()', () => {
    it('calls POST /kikx/api/v1/user with { email, firstName, lastName }', async () => {
      await registerUser({ email: 'user@example.com', firstName: 'Jane', lastName: 'Doe' });
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/user');
      assert.equal(fetchCalls[0].options.method, 'POST');
      assert.equal(
        fetchCalls[0].options.body,
        JSON.stringify({ email: 'user@example.com', firstName: 'Jane', lastName: 'Doe' }),
      );
    });
  });

  describe('getSessions()', () => {
    it('calls GET /kikx/api/v1/sessions', async () => {
      await getSessions();
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/sessions');
      assert.equal(fetchCalls[0].options.method, 'GET');
    });
  });

  describe('createSession()', () => {
    it('calls POST /kikx/api/v1/sessions with body', async () => {
      let data = { name: 'My Session', agentID: 'agent-1' };
      await createSession(data);
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/sessions');
      assert.equal(fetchCalls[0].options.method, 'POST');
      assert.equal(fetchCalls[0].options.body, JSON.stringify(data));
    });
  });

  describe('updateSession()', () => {
    it('calls PATCH /kikx/api/v1/sessions/:id with updates', async () => {
      let updates = { name: 'Renamed' };
      await updateSession('session-42', updates);
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/sessions/session-42');
      assert.equal(fetchCalls[0].options.method, 'PATCH');
      assert.equal(fetchCalls[0].options.body, JSON.stringify(updates));
    });
  });

  describe('deleteSession()', () => {
    it('calls DELETE /kikx/api/v1/sessions/:id', async () => {
      await deleteSession('session-42');
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/sessions/session-42');
      assert.equal(fetchCalls[0].options.method, 'DELETE');
    });
  });

  describe('getAgents()', () => {
    it('calls GET /kikx/api/v1/agents', async () => {
      await getAgents();
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/agents');
      assert.equal(fetchCalls[0].options.method, 'GET');
    });
  });

  describe('getAgent()', () => {
    it('calls GET /kikx/api/v1/agents/:id', async () => {
      await getAgent('agent-7');
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/agents/agent-7');
      assert.equal(fetchCalls[0].options.method, 'GET');
    });
  });

  describe('createAgent()', () => {
    it('calls POST /kikx/api/v1/agents with body', async () => {
      let data = { name: 'test-new', model: 'claude-opus-4-6' };
      await createAgent(data);
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/agents');
      assert.equal(fetchCalls[0].options.method, 'POST');
      assert.equal(fetchCalls[0].options.body, JSON.stringify(data));
    });
  });

  describe('updateAgent()', () => {
    it('calls PATCH /kikx/api/v1/agents/:id with updates', async () => {
      let updates = { model: 'claude-sonnet-4-6' };
      await updateAgent('agent-7', updates);
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/agents/agent-7');
      assert.equal(fetchCalls[0].options.method, 'PATCH');
      assert.equal(fetchCalls[0].options.body, JSON.stringify(updates));
    });
  });

  describe('deleteAgent()', () => {
    it('calls DELETE /kikx/api/v1/agents/:id', async () => {
      await deleteAgent('agent-7');
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/agents/agent-7');
      assert.equal(fetchCalls[0].options.method, 'DELETE');
    });
  });

  describe('addParticipant()', () => {
    it('calls POST /kikx/api/v1/sessions/:id/participants with body', async () => {
      let participantData = { userID: 'user-9', role: 'observer' };
      await addParticipant('session-42', participantData);
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/sessions/session-42/participants');
      assert.equal(fetchCalls[0].options.method, 'POST');
      assert.equal(fetchCalls[0].options.body, JSON.stringify(participantData));
    });
  });

  describe('removeParticipant()', () => {
    it('calls DELETE /kikx/api/v1/sessions/:id/participants/:id', async () => {
      await removeParticipant('session-42', 'participant-5');
      assert.equal(fetchCalls[0].url, '/kikx/api/v1/sessions/session-42/participants/participant-5');
      assert.equal(fetchCalls[0].options.method, 'DELETE');
    });
  });

  describe('error handling', () => {
    it('throws ApiError with correct status and body on non-2xx response', async () => {
      fetchResponses.push({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: { message: 'Session not found' },
      });

      await assert.rejects(
        () => getSession('missing-id'),
        (error) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 404);
          assert.equal(error.message, 'Session not found');
          assert.deepEqual(error.body, { message: 'Session not found' });
          return true;
        },
      );
    });

    it('calls onUnauthorized callback on 401 response', async () => {
      let callbackInvoked = false;
      setOnUnauthorized(() => { callbackInvoked = true; });

      fetchResponses.push({ ok: false, status: 401, statusText: 'Unauthorized', body: null });

      await assert.rejects(() => healthCheck(), (error) => error instanceof ApiError);
      assert.equal(callbackInvoked, true);
    });

    it('throws ApiError on 401 response', async () => {
      fetchResponses.push({ ok: false, status: 401, statusText: 'Unauthorized', body: null });

      await assert.rejects(
        () => healthCheck(),
        (error) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 401);
          return true;
        },
      );
    });

    it('ApiError has correct name, status, message, and body properties', () => {
      let error = new ApiError(500, 'Internal Server Error', { detail: 'boom' });
      assert.equal(error.name, 'ApiError');
      assert.equal(error.status, 500);
      assert.equal(error.message, 'Internal Server Error');
      assert.deepEqual(error.body, { detail: 'boom' });
      assert.ok(error instanceof Error);
    });

    it('falls back to statusText when error response body has no message field', async () => {
      fetchResponses.push({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: { code: 'OVERLOADED' },
      });

      await assert.rejects(
        () => healthCheck(),
        (error) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 503);
          assert.equal(error.message, 'Service Unavailable');
          return true;
        },
      );
    });
  });

  describe('request body serialization', () => {
    it('JSON.stringify\'s object body for POST requests', async () => {
      let data = { name: 'My Session' };
      await createSession(data);
      assert.equal(typeof fetchCalls[0].options.body, 'string');
      assert.equal(fetchCalls[0].options.body, JSON.stringify(data));
    });

    it('sets Content-Type: application/json when body is an object', async () => {
      await createSession({ name: 'test' });
      assert.equal(fetchCalls[0].options.headers['Content-Type'], 'application/json');
    });

    it('GET requests do not include a body', async () => {
      await getSessions();
      assert.equal(fetchCalls[0].options.body, undefined);
    });
  });
});
