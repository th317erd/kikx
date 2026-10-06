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

test('request-login-link strips ANSI escapes from the logged dev link', async () => {
  let logPath = await createLogFile();
  let { server, baseURL } = await listen(async (_request, response) => {
    await fs.appendFile(
      logPath,
      '\x1b[2m2026\x1b[0m \x1b[34mDEBUG\x1b[0m magic_link_url\x1b[0m\x1b[34m: \x1b[34m/auth/magic-link/verify?code=ansi-code\x1b[0m\n',
    );

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ data: { message: 'sent' } }));
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
    assert.equal(result.stdout.trim(), 'http://kikx.test/?code=ansi-code');
  } finally {
    await close(server);
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test('request-login-link --token exchanges the code for a bearer token', async () => {
  let seen = [];
  let logPath = await createLogFile();
  let { server, baseURL } = await listen(async (request, response) => {
    seen.push({ method: request.method, url: request.url });
    if (request.method === 'POST' && request.url === '/api/v1/auth/magic-link') {
      await fs.appendFile(logPath, 'magic_link_url="/auth/magic-link/verify?code=token-code"\x1b[0m\n');
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ data: { message: 'sent' } }));
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/auth/magic-link/verify?code=token-code') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ data: { token: 'test-bearer-token', refresh_token: 'r' } }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { message: 'Not Found' } }));
  });

  try {
    let result = await runScript([ 'alice@example.com', '--token' ], {
      env: {
        AEORDB_LOG_PATH: logPath,
        KIKX_URL: baseURL,
        KIKX_PUBLIC_URL: 'http://kikx.test',
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), 'test-bearer-token');
    assert.deepEqual(seen.map((entry) => `${entry.method} ${entry.url}`), [
      'POST /api/v1/auth/magic-link',
      'GET /api/v1/auth/magic-link/verify?code=token-code',
    ]);
  } finally {
    await close(server);
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test('request-login-link --token reports a verify response without a token', async () => {
  let logPath = await createLogFile();
  let { server, baseURL } = await listen(async (request, response) => {
    if (request.method === 'POST') {
      await fs.appendFile(logPath, 'magic_link_url="/auth/magic-link/verify?code=missing-token"\n');
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ data: { message: 'sent' } }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ data: {} }));
  });

  try {
    let result = await runScript([ 'alice@example.com', '-t' ], {
      env: {
        AEORDB_LOG_PATH: logPath,
        KIKX_URL: baseURL,
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not include a token/);
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

test('request-login-link loads dev environment defaults when present', async () => {
  let previousEnv = {
    AEORDB_LOG_PATH: process.env.AEORDB_LOG_PATH,
    KIKX_ENV_FILE: process.env.KIKX_ENV_FILE,
    KIKX_PORT: process.env.KIKX_PORT,
    KIKX_URL: process.env.KIKX_URL,
  };
  let tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-login-env-'));
  let logPath = path.join(tempDir, 'aeordb.log');
  let envPath = path.join(tempDir, '.env.dev');
  let seen = {};

  await fs.writeFile(logPath, 'startup log\n');

  let { server, baseURL } = await listen(async (request, response) => {
    seen.body = await readBody(request);
    await fs.appendFile(logPath, 'magic_link_url="/auth/magic-link/verify?code=env-code"\n');

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ data: { message: 'sent' } }));
  });

  let port = new URL(baseURL).port;

  try {
    delete process.env.AEORDB_LOG_PATH;
    delete process.env.KIKX_ENV_FILE;
    delete process.env.KIKX_PORT;
    delete process.env.KIKX_URL;

    await fs.writeFile(envPath, [
      `KIKX_PORT=${port}`,
      `AEORDB_LOG_PATH=${logPath}`,
    ].join('\n'));

    let result = await runScript([], {
      env: {
        KIKX_ENV_FILE: envPath,
      },
    });

    assert.equal(result.code, 0);
    assert.equal(seen.body, '{"email":"wegreenway@taraani.org"}');
    assert.equal(result.stdout.trim(), `http://127.0.0.1:${port}/?code=env-code`);
  } finally {
    await close(server);
    await fs.rm(tempDir, { recursive: true, force: true });

    for (let [key, value] of Object.entries(previousEnv)) {
      if (value === undefined)
        delete process.env[key];
      else
        process.env[key] = value;
    }
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
    assert.match(result.stderr, /KIKX_AUTH_MAILER_LOG_PATH/);
  } finally {
    await close(server);
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test('request-login-link reads the Kikx mailer log when the AeorDB log has no code', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-login-link-'));
  let kikxLogPath = path.join(dir, 'kikx-auth.log');
  let aeorDBLogPath = path.join(dir, 'aeordb.log');
  await fs.writeFile(kikxLogPath, 'startup log\n');
  await fs.writeFile(aeorDBLogPath, 'startup log\n');

  let { server, baseURL } = await listen(async (_request, response) => {
    await fs.appendFile(
      kikxLogPath,
      '[kikx-auth] magic link for alice@example.com: /api/v1/auth/magic-link/verify?code=kikx-only (code=kikx-only expires=2026-01-01T00:00:00.000Z)\n',
    );

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ data: { message: 'sent' } }));
  });

  try {
    let result = await runScript([ 'alice@example.com' ], {
      env: {
        KIKX_AUTH_MAILER_LOG_PATH: kikxLogPath,
        AEORDB_LOG_PATH: aeorDBLogPath,
        KIKX_URL: baseURL,
        KIKX_PUBLIC_URL: 'http://kikx.test',
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), 'http://kikx.test/?code=kikx-only');
  } finally {
    await close(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('request-login-link prefers the Kikx mailer log when both logs receive a code', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-login-link-'));
  let kikxLogPath = path.join(dir, 'kikx-auth.log');
  let aeorDBLogPath = path.join(dir, 'aeordb.log');
  await fs.writeFile(kikxLogPath, 'startup log\n');
  await fs.writeFile(aeorDBLogPath, 'startup log\n');

  let { server, baseURL } = await listen(async (_request, response) => {
    await fs.appendFile(
      kikxLogPath,
      '[kikx-auth] magic link for alice@example.com: /api/v1/auth/magic-link/verify?code=kikx-code (code=kikx-code expires=2026-01-01T00:00:00.000Z)\n',
    );
    await fs.appendFile(aeorDBLogPath, 'magic_link_url="/auth/magic-link/verify?code=aeordb-code"\n');

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ data: { message: 'sent' } }));
  });

  try {
    let result = await runScript([ 'alice@example.com' ], {
      env: {
        KIKX_AUTH_MAILER_LOG_PATH: kikxLogPath,
        AEORDB_LOG_PATH: aeorDBLogPath,
        KIKX_URL: baseURL,
        KIKX_PUBLIC_URL: 'http://kikx.test',
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), 'http://kikx.test/?code=kikx-code');
  } finally {
    await close(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createLogFile() {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-login-link-'));
  let logPath = path.join(dir, 'aeordb.log');
  await fs.writeFile(logPath, 'startup log\n');
  return logPath;
}
