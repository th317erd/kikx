'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

async function createStaticFixture() {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-static-'));
  let clientRoot = path.join(root, 'client');
  let aeorWebComponentsRoot = path.join(root, 'aeor-web-components');

  await fs.mkdir(path.join(clientRoot, 'styles'), { recursive: true });
  await fs.mkdir(path.join(aeorWebComponentsRoot, 'components'), { recursive: true });
  await fs.writeFile(path.join(clientRoot, 'index.html'), '<!doctype html><title>Kikx</title>');
  await fs.writeFile(path.join(clientRoot, 'styles', 'app.css'), 'body { color: white; }');
  await fs.writeFile(path.join(aeorWebComponentsRoot, 'elements.js'), 'export const elements = {};');

  return { root, clientRoot, aeorWebComponentsRoot };
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

test('GET / serves the browser client index', async () => {
  let fixture = await createStaticFixture();
  let server = createServer({
    clientRoot: fixture.clientRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/`);
    let body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(body, '<!doctype html><title>Kikx</title>');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('GET /vendor/aeor-web-components serves shared component assets', async () => {
  let fixture = await createStaticFixture();
  let server = createServer({
    clientRoot: fixture.clientRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/vendor/aeor-web-components/elements.js`);
    let body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(body, 'export const elements = {};');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('static routes reject path traversal outside configured roots', async () => {
  let fixture = await createStaticFixture();
  let server = createServer({
    clientRoot: fixture.clientRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/client/%2e%2e%2fpackage.json`);
    let body = await response.text();

    assert.equal(response.status, 403);
    assert.equal(body, 'Forbidden');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
