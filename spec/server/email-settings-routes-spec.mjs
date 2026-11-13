'use strict';

import '../support/test-env.mjs';

// Settings → Email endpoints (owner, 2026-11-13; reference UI = the Xenocept
// screenshot): GET/POST /api/v1/auth/mailer/settings + POST
// /api/v1/auth/mailer/test. Identity-gated like the rest of the auth family
// (requireIdentity → 401).
//
// P5 (plan: properties-store.md §6): persistence is the properties store —
// ONE global SECRET property, CLEAN CUT from .kikx/mailer.json (a leftover
// file is ignored: nothing in this family touches the filesystem anymore).
// Save hot-swaps the mailer through the context holder (authService captures
// a getMailer seam — no service recreation), the password never echoes, an
// undecryptable row surfaces as an `error` flag with env defaults, and POST
// without a store is 503.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleAuthRoutes } from '../../src/server/routes/auth-routes.mjs';
import { createMailer } from '../../src/core/auth/mailer.mjs';
import {
  MAILER_PROPERTY_KEY,
  writeStoredMailerSettings,
} from '../../src/core/auth/mailer-properties.mjs';
import { openPropertiesStore } from '../../src/core/properties/store.mjs';
import { createPropertiesFacade } from '../../src/core/properties/facade.mjs';
import { CorePropertyRegistry } from '../../src/core/properties/registry.mjs';
import { GrantsRegistry } from '../../src/core/properties/grants.mjs';
import {
  KIKX_AUTH_MAILER_FROM_PATH,
  KIKX_AUTH_MAILER_MODE_PATH,
  KIKX_AUTH_MAILER_SMTP_URL_PATH,
} from '../../src/core/config/config-paths.mjs';
import { fakeContext, fakeRequest, fakeResponse } from '../support/fake-http.mjs';

const KEY_A = 'a'.repeat(64);
const silent = { warn() {}, error() {}, info() {}, debug() {}, log() {} };

const accountStore = {
  async resolveIdentity(request) {
    if (request.headers?.['x-no-identity'])
      throw Object.assign(new Error('Sign in required'), { status: 401 });
    return { id: 'operator-1', email: 'w@example.com' };
  },
};

function envStore(extra = {}) {
  return {
    [KIKX_AUTH_MAILER_MODE_PATH]: 'log',
    [KIKX_AUTH_MAILER_SMTP_URL_PATH]: '',
    [KIKX_AUTH_MAILER_FROM_PATH]: 'Kikx <no-reply@localhost>',
    ...extra,
  };
}

async function makeStore(t, { filename = ':memory:', encryptionKey = null } = {}) {
  const store = await openPropertiesStore({
    driver: 'sqlite', filename, logger: silent, ...(encryptionKey ? { encryptionKey } : {}),
  });
  t.after(() => store.close());
  const facade = createPropertiesFacade({
    store,
    registry: new CorePropertyRegistry(),
    grants: new GrantsRegistry(),
    logger: silent,
  });
  return { store, facade };
}

async function call({ facade, env = envStore(), method, pathname, body, headers = {}, slot }) {
  const response = fakeResponse();
  try {
    await handleAuthRoutes({
      request: fakeRequest({ method, body: body === undefined ? '' : JSON.stringify(body), headers }),
      response,
      url: new URL(pathname, 'http://localhost'),
      context: fakeContext({
        accountStore,
        config: { get: async (p) => env[p] },
        mailerSlot: slot,
        ...(facade ? { propertiesFacade: facade } : {}),
      }),
    });
  } catch (error) {
    response.writeHead(error?.status || 500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
  }
  return { response };
}

test('GET returns resolved defaults with passwordSet and never a password', async (t) => {
  const { facade } = await makeStore(t);
  const { response } = await call({ facade, method: 'GET', pathname: '/api/v1/auth/mailer/settings' });
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body).data;
  assert.equal(data.settings.provider, 'log', 'env mode=log resolves to the log provider');
  assert.equal(data.passwordSet, false);
  assert.equal('password' in data.settings, false, 'the password field never appears in a GET');
  assert.equal(data.settings.fromAddress, 'no-reply@localhost', 'legacy From string pre-fills the form');
  assert.equal('error' in data, false, 'a healthy store reports no error flag');
});

test('POST persists as a SECRET property, hot-swaps the slot, echoes sanitized settings', async (t) => {
  const { facade, store } = await makeStore(t, { encryptionKey: KEY_A });
  const slot = { current: createMailer({ mode: 'log' }) };
  const { response } = await call({
    facade, method: 'POST', pathname: '/api/v1/auth/mailer/settings', slot,
    body: {
      provider: 'smtp', host: 'smtp.example.com', port: 465, username: 'u@example.com',
      password: 'hunter2', fromAddress: 'a@b.c', fromName: 'Kikx', tls: 'SSL',
    },
  });

  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body).data;
  assert.equal(data.settings.passwordSet, true, 'saved passwords report as set…');
  assert.equal('password' in data.settings, false, '…and are never echoed back');

  // Durable in the STORE as a sealed row (the clean cut: no file exists).
  const row = await store.get({ type: 'global', id: '' }, MAILER_PROPERTY_KEY);
  assert.equal(row.encryptionMethod, 'aes-256-gcm', 'envelope columns present — the row is SECRET');
  assert.equal(row.value.host, 'smtp.example.com');
  assert.equal(row.value.password, 'hunter2', 'server-side read unseals it');
  assert.equal(row.updatedBy, 'operator-1', 'audit seam records who saved');

  // Hot swap: the slot now holds an SMTP-mode mailer.
  assert.notEqual(slot.current, null);
  assert.equal(typeof slot.current.sendMagicLink, 'function');
  assert.equal(typeof slot.current.sendTest, 'function', 'both mailers expose sendTest');

  // A restart reads the property back (GET shows the saved config).
  const again = await call({ facade, method: 'GET', pathname: '/api/v1/auth/mailer/settings' });
  assert.equal(JSON.parse(again.response.body).data.settings.host, 'smtp.example.com', 'persisted');
});

test('POST rejects bad settings with 400 and writes nothing', async (t) => {
  const { facade, store } = await makeStore(t, { encryptionKey: KEY_A });
  for (const bad of [
    { provider: 'sendgrid', host: 'h', port: 587, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: '', port: 587, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: 'h', port: 70000, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: 'h', port: 587, fromAddress: 'nope' },
    { provider: 'smtp', host: 'h', port: 587, fromAddress: 'a@b.c', tls: 'FTP' },
  ]) {
    const { response } = await call({ facade, method: 'POST', pathname: '/api/v1/auth/mailer/settings', body: bad });
    assert.equal(response.statusCode, 400, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(await store.get({ type: 'global', id: '' }, MAILER_PROPERTY_KEY), null,
    'no partial row from rejections');
});

test('unauthenticated settings access is 401 (identity bar, like the auth family)', async (t) => {
  const { facade } = await makeStore(t);
  const { response } = await call({
    facade, method: 'GET', pathname: '/api/v1/auth/mailer/settings',
    headers: { 'x-no-identity': '1' },
  });
  assert.equal(response.statusCode ?? 0, 401, 'missing identity → 401, never an implicit read');
});

test('POST without a properties store is 503 (named, not a crash)', async (t) => {
  void t;
  const { response } = await call({
    facade: null, method: 'POST', pathname: '/api/v1/auth/mailer/settings',
    body: { provider: 'smtp', host: 'h', port: 587, fromAddress: 'a@b.c' },
  });
  assert.equal(response.statusCode, 503);
  assert.match(JSON.parse(response.body).error.message, /properties store unavailable/);
});

test('undecryptable row: GET 200 with error flag + env defaults (never a 500)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-mail-undec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'properties.db');

  const sealed = await openPropertiesStore({ driver: 'sqlite', filename: file, encryptionKey: KEY_A, logger: silent });
  await writeStoredMailerSettings(createPropertiesFacade({
    store: sealed, registry: new CorePropertyRegistry(), grants: new GrantsRegistry(), logger: silent,
  }), { provider: 'smtp', host: 'smtp.secret.example', password: 'hunter2' });
  await sealed.close();

  const keyless = await openPropertiesStore({ driver: 'sqlite', filename: file, logger: silent });
  t.after(() => keyless.close());
  const facade = createPropertiesFacade({
    store: keyless, registry: new CorePropertyRegistry(), grants: new GrantsRegistry(), logger: silent,
  });

  const { response } = await call({ facade, method: 'GET', pathname: '/api/v1/auth/mailer/settings' });
  assert.equal(response.statusCode, 200, 'a decrypt failure never becomes a 500');
  const data = JSON.parse(response.body).data;
  assert.equal(data.error, 'undecryptable', 'the flag names the condition');
  assert.equal(data.settings.provider, 'log', 'falls back to env defaults (host is NOT leaked)');
  assert.equal(data.settings.host, '', 'the undecryptable host never appears');
  assert.equal(data.passwordSet, false);
});

test('legacy .kikx/mailer.json is IGNORED (clean cut — nothing reads it)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-mail-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.kikx'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kikx', 'mailer.json'),
    JSON.stringify({ provider: 'smtp', host: 'evil-from-file.example', password: 'stale' }));

  const { facade } = await makeStore(t);
  const { response } = await call({ facade, method: 'GET', pathname: '/api/v1/auth/mailer/settings' });
  const data = JSON.parse(response.body).data;
  assert.equal(data.settings.provider, 'log', 'env defaults — the legacy file contributes NOTHING');
  assert.equal(data.settings.host, '', 'no host leaked from a leftover file');
});

test('POST test: log mode sends through the log mailer; bad address 400; smtp without nodemailer = clear 502', async (t) => {
  const { facade } = await makeStore(t, { encryptionKey: KEY_A });

  // log mode (default): the test line goes through the log mailer.
  let r = await call({ facade, method: 'POST', pathname: '/api/v1/auth/mailer/test', body: { to: 'dev@example.com' } });
  assert.equal(r.response.statusCode, 200);
  const ok = JSON.parse(r.response.body).data;
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'log', 'the response names the mode that actually sent');

  // invalid address
  r = await call({ facade, method: 'POST', pathname: '/api/v1/auth/mailer/test', body: { to: 'not-an-email' } });
  assert.equal(r.response.statusCode, 400);

  // smtp mode without nodemailer installed: a CLEAR error, never a hang.
  await call({
    facade, method: 'POST', pathname: '/api/v1/auth/mailer/settings',
    body: { provider: 'smtp', host: 'smtp.example.com', port: 587, username: 'u', password: 'p', fromAddress: 'a@b.c', fromName: 'K', tls: 'STARTTLS' },
  });
  r = await call({ facade, method: 'POST', pathname: '/api/v1/auth/mailer/test', body: { to: 'dev@example.com' } });
  assert.equal(r.response.statusCode, 502, 'transport failure surfaces as 502, not a fake success');
  assert.match(JSON.parse(r.response.body).error.message, /nodemailer|smtp/i, 'and names the cause');
});
