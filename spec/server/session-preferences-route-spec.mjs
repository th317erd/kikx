'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { createServer } from '../../src/server/create-server.mjs';
import { matchSessionPreferencesRoute } from '../../src/server/routes/route-matchers.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('matchSessionPreferencesRoute matches only a session id followed by /preferences', () => {
  assert.deepEqual(matchSessionPreferencesRoute('/api/v1/sessions/ses_1/preferences'), { sessionID: 'ses_1' });
  assert.deepEqual(matchSessionPreferencesRoute('/api/v1/sessions/a%2Fb/preferences'), { sessionID: 'a/b' });
  assert.equal(matchSessionPreferencesRoute('/api/v1/sessions/ses_1'), null);
  assert.equal(matchSessionPreferencesRoute('/api/v1/sessions/ses_1/preferences/extra'), null);
});

test('GET /api/v1/sessions/:id/preferences returns the effective map and own values', async () => {
  let server = await createServer({ context: appContext() });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_child/preferences`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.preferences, {
      'ocr.image_proxy': false,
      theme: 'dark',
    });
    assert.deepEqual(body.data.ownPreferences, { theme: 'dark' });
    assert.equal(body.data.defaults['ocr.image_proxy'], true);
    assert.deepEqual(body.data.sessionID, 'ses_child');
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:id/preferences?key= returns one focused value', async () => {
  let server = await createServer({ context: appContext() });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_child/preferences?key=ocr.image_proxy`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.key, 'ocr.image_proxy');
    assert.equal(body.data.value, false);
    assert.equal(body.data.found, true);

    let unknown = await (await fetch(`${baseURL}/api/v1/sessions/ses_child/preferences?key=custom.none`)).json();
    assert.equal(unknown.data.found, false);
    assert.equal(unknown.data.value, undefined);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:id/preferences rejects a malformed key with 400', async () => {
  let server = await createServer({ context: appContext() });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_child/preferences?key=bad%20key`);
    let body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error.message, /Invalid preference key/);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:id/preferences reports an unknown session as 404', async () => {
  let server = await createServer({ context: appContext() });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/missing/preferences`);
    assert.equal(response.status, 404);
  } finally {
    await close(server);
  }
});

function appContext() {
  return new AppContext({
    aeordb: {},
    frameRuntime: {
      on() {},
      async getEffectivePreferences(sessionID) {
        if (sessionID === 'missing') {
          let error = new Error(`Unknown session: ${sessionID}`);
          error.status = 404;
          throw error;
        }

        return {
          sessionID,
          preferences: { 'ocr.image_proxy': false, theme: 'dark' },
          ownPreferences: { theme: 'dark' },
          chain: [ 'ses_root', 'ses_child' ],
          complete: true,
        };
      },
    },
  });
}
