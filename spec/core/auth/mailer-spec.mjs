'use strict';

// Exercises the dev log mailer's optional file sink: the in-memory log stays
// authoritative, the file is a best-effort mirror, and a failed file write is
// reported as a warning rather than failing the login.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLogMailer, createMailer } from '../../../src/core/auth/mailer.mjs';

const MESSAGE = {
  to: 'alice@example.com',
  url: '/api/v1/auth/magic-link/verify?code=abc123',
  code: 'abc123',
  expiresAt: 1_700_000_000_000,
};

async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-mailer-'));
}

test('createLogMailer writes the magic link to the log function and the file', async () => {
  let dir = await createTempDir();
  let logPath = path.join(dir, 'kikx-auth.log');
  let logged = [];

  try {
    let mailer = createLogMailer({ log: (message) => logged.push(message), logPath });
    let result = await mailer.sendMagicLink(MESSAGE);

    assert.deepEqual(result, MESSAGE);

    assert.equal(logged.length, 1);
    assert.match(logged[0], /magic link for alice@example\.com/);
    assert.ok(logged[0].includes(MESSAGE.url));
    assert.ok(logged[0].includes('code=abc123'));

    let contents = await fs.readFile(logPath, 'utf8');
    assert.match(contents, /magic link for alice@example\.com/);
    assert.ok(contents.includes(MESSAGE.url));
    assert.ok(contents.endsWith('\n'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createLogMailer creates missing parent directories for the log file', async () => {
  let dir = await createTempDir();
  let logPath = path.join(dir, 'nested', 'deeper', 'kikx-auth.log');

  try {
    let mailer = createLogMailer({ log: () => {}, logPath });
    await mailer.sendMagicLink(MESSAGE);

    let contents = await fs.readFile(logPath, 'utf8');
    assert.ok(contents.includes(MESSAGE.url));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createLogMailer swallows a file write failure and warns through log', async () => {
  let dir = await createTempDir();
  let logged = [];

  try {
    // A directory path makes appendFile fail (EISDIR); the login must not reject.
    let mailer = createLogMailer({ log: (message) => logged.push(message), logPath: dir });
    let result = await mailer.sendMagicLink(MESSAGE);

    assert.deepEqual(result, MESSAGE);
    assert.equal(logged.length, 2);
    assert.match(logged[0], /magic link for alice@example\.com/);
    assert.match(logged[1], /unable to write magic-link log/);
    assert.ok(logged[1].includes(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createLogMailer without logPath writes no file', async () => {
  let dir = await createTempDir();
  let logged = [];

  try {
    let mailer = createLogMailer({ log: (message) => logged.push(message) });
    await mailer.sendMagicLink(MESSAGE);

    assert.equal(logged.length, 1);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createMailer in log mode forwards logPath to the file sink', async () => {
  let dir = await createTempDir();
  let logPath = path.join(dir, 'kikx-auth.log');

  try {
    let mailer = createMailer({ mode: 'log', log: () => {}, logPath });
    await mailer.sendMagicLink(MESSAGE);

    let contents = await fs.readFile(logPath, 'utf8');
    assert.ok(contents.includes('code=abc123'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createMailer rejects an unknown mode', () => {
  assert.throws(
    () => createMailer({ mode: 'bogus' }),
    (error) => error.status === 400 && error.code === 'invalid_mailer_mode',
  );
});

test('createMailer rejects smtp mode without a url', () => {
  assert.throws(
    () => createMailer({ mode: 'smtp' }),
    (error) => error.status === 500 && error.code === 'smtp_unavailable',
  );
});
