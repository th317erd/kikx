'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';

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

test('GET /health reports service state', async () => {
  let server = createServer({
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'http://aeor.test/system/events',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/health`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      services: {
        aeordb: true,
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/aeordb/events-url returns delegated AeorDB events URL', async () => {
  let server = createServer({
    context: new AppContext({
      aeordb: {
        eventsURL: (params) => `events:${params.events}:${params.path_prefix}`,
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/aeordb/events-url?events=entries_created&path_prefix=/sessions`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      data: {
        url: 'events:entries_created:/sessions',
      },
    });
  } finally {
    await close(server);
  }
});

test('unknown routes return JSON 404', async () => {
  let server = createServer({
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/missing`);
    let body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: {
        message: 'Not Found',
      },
    });
  } finally {
    await close(server);
  }
});

