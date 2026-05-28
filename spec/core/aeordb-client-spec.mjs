'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AeorDBClient, AeorDBError } from '../../src/core/aeordb/aeordb-client.mjs';

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('AeorDBClient requires a baseURL', () => {
  assert.throws(() => new AeorDBClient({ baseURL: '', fetchImpl: async () => {} }), /baseURL/);
});

test('putFile writes JSON to /files/{path}', async () => {
  let calls = [];
  let client = new AeorDBClient({
    baseURL: 'http://aeor.test',
    token: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });

  let result = await client.putFile('/sessions/ses_1/session.json', { id: 'ses_1' });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.toString(), 'http://aeor.test/files/sessions/ses_1/session.json');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body, '{"id":"ses_1"}');
});

test('patchFile uses AeorDB merge-patch content type', async () => {
  let seen;
  let client = new AeorDBClient({
    baseURL: 'http://aeor.test',
    fetchImpl: async (_url, options) => {
      seen = options;
      return jsonResponse({ patched: true });
    },
  });

  await client.patchFile('/frames/frm_1.json', { processed: true });

  assert.equal(seen.method, 'PATCH');
  assert.equal(seen.headers['Content-Type'], 'application/merge-patch+json');
  assert.equal(seen.body, '{"processed":true}');
});

test('queryFiles posts to /files/query', async () => {
  let seenURL;
  let client = new AeorDBClient({
    baseURL: 'http://aeor.test/',
    fetchImpl: async (url) => {
      seenURL = url.toString();
      return jsonResponse({ results: [] });
    },
  });

  await client.queryFiles({ path: '/sessions' });

  assert.equal(seenURL, 'http://aeor.test/files/query');
});

test('eventsURL includes filters and token', () => {
  let client = new AeorDBClient({
    baseURL: 'http://aeor.test',
    token: 'secret',
    fetchImpl: async () => jsonResponse({}),
  });

  let url = new URL(client.eventsURL({
    events: [ 'entries_created', 'entries_deleted' ],
    path_prefix: '/sessions/ses_1',
  }));

  assert.equal(url.toString(), 'http://aeor.test/system/events?events=entries_created%2Centries_deleted&path_prefix=%2Fsessions%2Fses_1&token=secret');
});

test('request throws AeorDBError for HTTP errors', async () => {
  let client = new AeorDBClient({
    baseURL: 'http://aeor.test',
    fetchImpl: async () => jsonResponse({ error: { message: 'nope' } }, { ok: false, status: 503 }),
  });

  await assert.rejects(
    () => client.getFile('/missing.json'),
    (error) => error instanceof AeorDBError && error.status === 503 && error.message === 'nope',
  );
});

test('request throws AeorDBError for non-JSON responses', async () => {
  let client = new AeorDBClient({
    baseURL: 'http://aeor.test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return '<html>not json</html>';
      },
    }),
  });

  await assert.rejects(
    () => client.getFile('/bad.json'),
    (error) => error instanceof AeorDBError && /non-JSON/.test(error.message),
  );
});

test('request wraps fetch failures', async () => {
  let client = new AeorDBClient({
    baseURL: 'http://aeor.test',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  await assert.rejects(
    () => client.getFile('/down.json'),
    (error) => error instanceof AeorDBError && /ECONNREFUSED/.test(error.message),
  );
});

