'use strict';

import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { shutdownHTTPServer } from '../../src/server/shutdown.mjs';

test('shutdownHTTPServer closes an idle server', { timeout: 2000 }, async () => {
  let server = http.createServer((_request, response) => {
    response.end('ok');
  });
  let baseURL = await listen(server);

  try {
    let response = await fetch(baseURL);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');

    let result = await shutdownHTTPServer(server, {
      forceAfterMS: 25,
      timeoutMS: 1000,
    });

    assert.deepEqual(result, {
      timedOut: false,
      error: null,
    });
    assert.equal(server.listening, false);
  } finally {
    if (server.listening)
      await close(server);
  }
});

test('shutdownHTTPServer force-closes active SSE responses', { timeout: 2000 }, async () => {
  let server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    response.write('event: connected\n');
    response.write('data: {"ok":true}\n\n');
  });
  let baseURL = await listen(server);
  let request;
  let response;

  try {
    request = http.get(`${baseURL}/api/v1/events`);
    request.on('error', () => {});
    [ response ] = await once(request, 'response');
    response.on('error', () => {});
    await once(response, 'data');

    let responseClosed = new Promise((resolve) => response.once('close', resolve));
    let result = await shutdownHTTPServer(server, {
      forceAfterMS: 10,
      timeoutMS: 1000,
    });

    assert.deepEqual(result, {
      timedOut: false,
      error: null,
    });
    assert.equal(server.listening, false);
    await withTimeout(responseClosed, 500, 'SSE response did not close');
  } finally {
    request?.destroy();
    response?.destroy();
    if (server.listening)
      await close(server);
  }
});

test('shutdownHTTPServer reports timeout when close cannot complete', { timeout: 2000 }, async () => {
  let calls = [];
  let server = {
    close() {
      calls.push('close');
    },
    closeIdleConnections() {
      calls.push('closeIdleConnections');
    },
    closeAllConnections() {
      calls.push('closeAllConnections');
    },
  };

  let result = await shutdownHTTPServer(server, {
    forceAfterMS: 10,
    timeoutMS: 25,
  });

  assert.deepEqual(result, {
    timedOut: true,
    error: null,
  });
  assert.deepEqual(calls, [
    'close',
    'closeIdleConnections',
    'closeAllConnections',
  ]);
});

test('shutdownHTTPServer reports force-close errors', { timeout: 2000 }, async () => {
  let error = new Error('force close failed');
  let server = {
    close() {},
    closeAllConnections() {
      throw error;
    },
  };

  let result = await shutdownHTTPServer(server, {
    forceAfterMS: 10,
    timeoutMS: 1000,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.error, error);
});

test('shutdownHTTPServer reports server.close errors', { timeout: 2000 }, async () => {
  let error = new Error('close failed');
  let closeIdleCalled = false;
  let server = {
    close() {
      throw error;
    },
    closeIdleConnections() {
      closeIdleCalled = true;
    },
  };

  let result = await shutdownHTTPServer(server, {
    forceAfterMS: 10,
    timeoutMS: 1000,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.error, error);
  assert.equal(closeIdleCalled, false);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      let address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function withTimeout(promise, timeoutMS, message) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMS);
    }),
  ]).finally(() => clearTimeout(timer));
}
