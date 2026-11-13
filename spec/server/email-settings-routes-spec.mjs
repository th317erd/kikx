'use strict';

import '../support/test-env.mjs';

// Settings → Email endpoints (owner, 2026-11-13; reference UI = the Xenocept
// screenshot): GET/POST /api/v1/auth/mailer/settings + POST
// /api/v1/auth/mailer/test. Identity-gated like the rest of the auth family
// (requireIdentity → 401). Save persists to .kikx/mailer.json (0600), HOT
// SWAPS the mailer through the context holder (authService captures a
// getMailer seam — no service recreation), and never echoes the password.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleAuthRoutes } from '../../src/server/routes/auth-routes.mjs';
import { createMailer } from '../../src/core/auth/mailer.mjs';
import { mailerSettingsFile } from '../../src/core/auth/mailer-settings.mjs';
import {
  KIKX_AUTH_MAILER_FROM_PATH,
  KIKX_AUTH_MAILER_MODE_PATH,
  KIKX_AUTH_MAILER_SMTP_URL_PATH,
  KIKX_CWD_PATH,
} from '../../src/core/config/config-paths.mjs';
import { fakeContext, fakeRequest, fakeResponse } from '../support/fake-http.mjs';

function tmpCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-mailrt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const accountStore = {
  async resolveIdentity(request) {
    if (request.headers?.['x-no-identity'])
      Object.assign(new Error('Sign in required'), { status: 401 });
    if (request.headers?.['x-no-identity'])
      throw Object.assign(new Error('Sign in required'), { status: 401 });
    return { id: 'operator-1', email: 'w@example.com' };
  },
};

function envStore(cwd, extra = {}) {
  return {
    // The spec isolates every file read/write under its tmp cwd — WITHOUT
    // this key runtimeRootForConfig falls back to os.homedir() and the test
    // reads/writes the REAL ~/.kikx/mailer.json (observed: it did, once).
    [KIKX_CWD_PATH]: cwd,
    [KIKX_AUTH_MAILER_MODE_PATH]: 'log',
    [KIKX_AUTH_MAILER_SMTP_URL_PATH]: '',
    [KIKX_AUTH_MAILER_FROM_PATH]: 'Kikx <no-reply@localhost>',
    ...extra,
  };
}

async function call({ cwd, store, method, pathname, body, headers = {}, slot }) {
  const response = fakeResponse();
  // Mirror auth-routes-spec's driver: handleAuthRoutes THROWS httpError/
  // authError (both carry .status) and the real router maps them — here we
  // map them onto the fake response so tests can assert status codes.
  try {
    await handleAuthRoutes({
      request: fakeRequest({ method, body: body === undefined ? '' : JSON.stringify(body), headers }),
      response,
      url: new URL(pathname, 'http://localhost'),
      context: fakeContext({
        accountStore,
        config: { get: async (p) => store[p] },
        mailerSlot: slot,
        cwd,
      }),
    });
  } catch (error) {
    response.writeHead(error?.status || 500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
  }
  return { handled: true, response };
}

test('GET returns resolved defaults with passwordSet and never a password', async (t) => {
  const cwd = tmpCwd(t);
  const { handled, response } = await call({ cwd, store: envStore(cwd), method: 'GET', pathname: '/api/v1/auth/mailer/settings' });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body).data;
  assert.equal(data.settings.provider, 'log', 'env mode=log resolves to the log provider');
  assert.equal(data.passwordSet, false);
  assert.equal('password' in data.settings, false, 'the password field never appears in a GET');
  assert.equal(data.settings.fromAddress, 'no-reply@localhost', 'legacy From string pre-fills the form');
});

test('POST persists 0600, hot-swaps the mailer slot, returns sanitized settings', async (t) => {
  const cwd = tmpCwd(t);
  const slot = { current: createMailer({ mode: 'log' }) };
  const { response } = await call({
    cwd, store: envStore(cwd), method: 'POST', pathname: '/api/v1/auth/mailer/settings', slot,
    body: {
      provider: 'smtp', host: 'smtp.example.com', port: 465, username: 'u@example.com',
      password: 'hunter2', fromAddress: 'a@b.c', fromName: 'Kikx', tls: 'SSL',
    },
  });

  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body).data;
  assert.equal(data.settings.passwordSet, true, 'saved passwords report as set…');
  assert.equal('password' in data.settings, false, '…and are never echoed back');

  const stat = fs.statSync(mailerSettingsFile(cwd));
  assert.equal(stat.mode & 0o777, 0o600, 'durable file is owner-only');

  // Hot swap: the slot now holds an SMTP-mode mailer (sendMagicLink present,
  // transport lazy — nodemailer absent in this env, so no network happens on
  // construction).
  assert.notEqual(slot.current, null);
  assert.equal(typeof slot.current.sendMagicLink, 'function');
  assert.equal(typeof slot.current.sendTest, 'function', 'both mailers expose sendTest');

  // And a restart would read the file back (GET now shows the saved config).
  const again = await call({ cwd, store: envStore(cwd), method: 'GET', pathname: '/api/v1/auth/mailer/settings' });
  assert.equal(JSON.parse(again.response.body).data.settings.host, 'smtp.example.com', 'persisted');
});

test('POST rejects bad settings with 400 and writes nothing', async (t) => {
  const cwd = tmpCwd(t);
  for (const bad of [
    { provider: 'sendgrid', host: 'h', port: 587, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: '', port: 587, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: 'h', port: 70000, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: 'h', port: 587, fromAddress: 'nope' },
    { provider: 'smtp', host: 'h', port: 587, fromAddress: 'a@b.c', tls: 'FTP' },
  ]) {
    const { response } = await call({ cwd, store: envStore(cwd), method: 'POST', pathname: '/api/v1/auth/mailer/settings', body: bad });
    assert.equal(response.statusCode, 400, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.existsSync(mailerSettingsFile(cwd)), false, 'no partial file from rejections');
});

test('unauthenticated settings access is 401 (identity bar, like the auth family)', async (t) => {
  const cwd = tmpCwd(t);
  const { response } = await call({
    cwd, store: envStore(cwd), method: 'GET', pathname: '/api/v1/auth/mailer/settings',
    headers: { 'x-no-identity': '1' },
  }).catch((error) => ({ response: { statusCode: error?.status } }));
  assert.equal(response?.statusCode ?? 0, 401, 'missing identity → 401, never an implicit read');
});

test('POST test: log mode sends through the log mailer; bad address 400; smtp without nodemailer = clear 502', async (t) => {
  const cwd = tmpCwd(t);

  // log mode (default): the test line goes through the log mailer.
  let r = await call({ cwd, store: envStore(cwd), method: 'POST', pathname: '/api/v1/auth/mailer/test', body: { to: 'dev@example.com' } });
  assert.equal(r.response.statusCode, 200);
  const ok = JSON.parse(r.response.body).data;
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'log', 'the response names the mode that actually sent');

  // invalid address
  r = await call({ cwd, store: envStore(cwd), method: 'POST', pathname: '/api/v1/auth/mailer/test', body: { to: 'not-an-email' } });
  assert.equal(r.response.statusCode, 400);

  // smtp mode without nodemailer installed: a CLEAR error, never a hang.
  await call({
    cwd, store: envStore(cwd), method: 'POST', pathname: '/api/v1/auth/mailer/settings',
    body: { provider: 'smtp', host: 'smtp.example.com', port: 587, username: 'u', password: 'p', fromAddress: 'a@b.c', fromName: 'K', tls: 'STARTTLS' },
  });
  r = await call({ cwd, store: envStore(cwd), method: 'POST', pathname: '/api/v1/auth/mailer/test', body: { to: 'dev@example.com' } });
  assert.equal(r.response.statusCode, 502, 'transport failure surfaces as 502, not a fake success');
  assert.match(JSON.parse(r.response.body).error.message, /nodemailer|smtp/i, 'and names the cause');
});
