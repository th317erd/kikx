'use strict';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

function runScript(args = [], options = {}) {
  return new Promise((resolve) => {
    let child = spawn(process.execPath, [ 'scripts/request-login-link.mjs', ...args ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function listen(handler) {
  let server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve({
        server,
        baseURL: `http://${address.address}:${address.port}`,
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readBody(request) {
  let chunks = [];
  for await (let chunk of request)
    chunks.push(chunk);

  return Buffer.concat(chunks).toString('utf8');
}

test('request-login-link requires an email', async () => {
  let result = await runScript([], {
    env: {
      KIKX_LOGIN_EMAIL: '',
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Usage: npm run login-link -- <email>/);
});

test('request-login-link posts the email to the Kikx auth proxy', async () => {
  let seen = {};
  let { server, baseURL } = await listen(async (request, response) => {
    seen.method = request.method;
    seen.url = request.url;
    seen.headers = request.headers;
    seen.body = await readBody(request);

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({
      data: {
        message: 'If an account exists, a login link has been sent.',
      },
    }));
  });

  try {
    let result = await runScript([ 'alice@example.com' ], {
      env: {
        KIKX_URL: baseURL,
      },
    });

    assert.equal(result.code, 0);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v1/auth/magic-link');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.body, '{"email":"alice@example.com"}');
    assert.match(result.stdout, /login link has been sent/);
  } finally {
    await close(server);
  }
});

test('request-login-link reports Kikx auth errors', async () => {
  let { server, baseURL } = await listen((_request, response) => {
    response.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({
      error: {
        message: 'Rate limit exceeded',
      },
    }));
  });

  try {
    let result = await runScript([ 'alice@example.com' ], {
      env: {
        KIKX_URL: baseURL,
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Rate limit exceeded/);
  } finally {
    await close(server);
  }
});
