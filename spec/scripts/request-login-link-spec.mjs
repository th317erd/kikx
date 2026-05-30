'use strict';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

test('request-login-link posts the email to the Kikx auth proxy', async () => {
  let seen = {};
  let logPath = await createLogFile();
  let { server, baseURL } = await listen(async (request, response) => {
    seen.method = request.method;
    seen.url = request.url;
    seen.headers = request.headers;
    seen.body = await readBody(request);
    await fs.appendFile(logPath, 'magic_link_url="/auth/magic-link/verify?code=abc123"\n');

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
        AEORDB_LOG_PATH: logPath,
        KIKX_URL: baseURL,
        KIKX_PUBLIC_URL: 'http://kikx.test',
      },
    });

    assert.equal(result.code, 0);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v1/auth/magic-link');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.body, '{"email":"alice@example.com"}');
    assert.equal(result.stdout.trim(), 'http://kikx.test/?code=abc123');
  } finally {
    await close(server);
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test('request-login-link defaults to Wyatt email when no email is provided', async () => {
  let seen = {};
  let logPath = await createLogFile();
  let { server, baseURL } = await listen(async (request, response) => {
    seen.body = await readBody(request);
    await fs.appendFile(logPath, 'magic_link_url="/auth/magic-link/verify?code=default-code"\n');

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
    let result = await runScript([], {
      env: {
        AEORDB_LOG_PATH: logPath,
        KIKX_URL: baseURL,
        KIKX_LOGIN_EMAIL: '',
      },
    });

    assert.equal(result.code, 0);
    assert.equal(seen.body, '{"email":"wegreenway@taraani.org"}');
  } finally {
    await close(server);
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test('request-login-link reports Kikx auth errors', async () => {
  let logPath = await createLogFile();
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
        AEORDB_LOG_PATH: logPath,
        KIKX_URL: baseURL,
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Rate limit exceeded/);
  } finally {
    await close(server);
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test('request-login-link fails loudly when AeorDB does not log the dev link', async () => {
  let logPath = await createLogFile();
  let { server, baseURL } = await listen(async (_request, response) => {
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
        AEORDB_LOG_PATH: logPath,
        KIKX_URL: baseURL,
        LOGIN_LINK_TIMEOUT_MS: '10',
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /AEORDB_LOG_MAGIC_LINKS=1/);
  } finally {
    await close(server);
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

async function createLogFile() {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-login-link-'));
  let logPath = path.join(dir, 'aeordb.log');
  await fs.writeFile(logPath, 'startup log\n');
  return logPath;
}
