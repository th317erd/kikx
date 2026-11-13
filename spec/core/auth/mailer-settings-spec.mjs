'use strict';

import '../../support/test-env.mjs';

// Email settings resolution (owner, 2026-11-13; plan P5 — CLEAN CUT):
// resolve/validate/sanitize/compose are PURE mappings over env defaults +
// STORED values (the properties store, one global secret property — see
// mailer-properties.mjs and email-settings-routes-spec). The .kikx/mailer.json
// reader/writer no longer exists anywhere; nothing in this spec touches a file.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveMailerSettings,
  validateMailerSettings,
  sanitizeMailerSettings,
  composeFrom,
  nodemailerOptionsFrom,
} from '../../../src/core/auth/mailer-settings.mjs';

function tmpCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-mail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('stored settings override env field-by-field; empty stored fields never clobber', () => {
  // Env arrives in the LEGACY shape the server actually carries (mode +
  // smtp URL + From string) — resolve derives structured fields from it.
  const env = {
    mode: 'smtp',
    smtpUrl: 'smtp://env-user:env-pass@env-host:1025',
    from: 'Env Name <env@env.example>',
  };
  const derived = resolveMailerSettings({ env });
  assert.equal(derived.username, 'env-user', 'structured fields derive from the legacy env');
  assert.equal(derived.host, 'env-host');
  assert.equal(derived.fromName, 'Env Name');

  const merged = resolveMailerSettings({ env, stored: { host: 'stored-host', port: 587 } });
  assert.equal(merged.host, 'stored-host', 'stored wins');
  assert.equal(merged.port, 587, 'stored wins numerically too');
  assert.equal(merged.username, 'env-user', 'unset stored field keeps the env-derived value');
  assert.equal(merged.password, 'env-pass');
  assert.equal(merged.tls, 'STARTTLS', 'plain smtp:// means STARTTLS');
  assert.equal(merged.fromName, 'Env Name', 'the From string survives a stored overlay');

  const empty = resolveMailerSettings({ env, stored: {} });
  assert.deepEqual(empty, derived, 'an empty stored object changes nothing');

  assert.deepEqual(resolveMailerSettings({ env: {} }), {
    provider: 'log', host: '', port: 587, username: '', password: '',
    fromAddress: '', fromName: '', tls: 'STARTTLS',
  }, 'pure defaults when nothing is configured');
});

test('legacy env smtpUrl parses into structured fields (smtps => SSL, else STARTTLS)', () => {
  const fromSmtps = resolveMailerSettings({ env: { provider: 'smtp', smtpUrl: 'smtps://alice:s3cret@smtp.example:465' } });
  assert.equal(fromSmtps.provider, 'smtp');
  assert.equal(fromSmtps.host, 'smtp.example');
  assert.equal(fromSmtps.port, 465);
  assert.equal(fromSmtps.username, 'alice');
  assert.equal(fromSmtps.password, 's3cret');
  assert.equal(fromSmtps.tls, 'SSL', 'smtps:// means implicit TLS');

  const starttls = resolveMailerSettings({ env: { provider: 'smtp', smtpUrl: 'smtp://bob@mail.example:1025' } });
  assert.equal(starttls.tls, 'STARTTLS', 'plain smtp:// means STARTTLS');
  assert.equal(starttls.port, 1025);
  assert.equal(starttls.password, '', 'no password in the URL stays empty');

  const fromString = resolveMailerSettings({ env: { from: 'Kikx Bot <no-reply@localhost>' } });
  assert.equal(fromString.fromAddress, 'no-reply@localhost', 'legacy From header splits');
  assert.equal(fromString.fromName, 'Kikx Bot');
  assert.equal(resolveMailerSettings({ env: { from: 'plain@example.com' } }).fromAddress, 'plain@example.com',
    'bare address passes through');
});

test('validate accepts the form shape and rejects hostile input with 400s', () => {
  const good = validateMailerSettings({
    provider: 'smtp', host: 'smtp.example.com', port: 587,
    username: 'u@example.com', password: 'p', fromAddress: 'a@b.c',
    fromName: 'Kikx', tls: 'STARTTLS',
  });
  assert.equal(good.provider, 'smtp');

  for (const bad of [
    { provider: 'sendgrid' },
    { provider: 'smtp', host: '', port: 587, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: 'h', port: 99999, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: 'h', port: 0, fromAddress: 'a@b.c' },
    { provider: 'smtp', host: 'h', port: 587, fromAddress: 'not-an-email' },
    { provider: 'smtp', host: 'h', port: 587, fromAddress: 'a@b.c', tls: 'FTP' },
  ]) {
    assert.throws(() => validateMailerSettings(bad), (error) => error?.status === 400 || error?.statusCode === 400 || /invalid/i.test(String(error?.message)),
      `rejects ${JSON.stringify(bad)}`);
  }
});

// A complete settings object for the mapping assertions below (the old file
// round-trip test that shared it moved to the store-side specs, P5).
const FULL_FILE_SETTINGS = {
  provider: 'smtp', host: 'smtp.example.com', port: 465, username: 'u@example.com',
  password: 'hunter2', fromAddress: 'no@reply.example', fromName: 'Kikx Bot', tls: 'SSL',
};

test('sanitize never echoes the password; composeFrom and nodemailer mapping', () => {
  const safe = sanitizeMailerSettings(FULL_FILE_SETTINGS);
  assert.equal('password' in safe, false, 'the password never leaves the server');
  assert.equal(safe.passwordSet, true, 'the form knows one IS stored');
  assert.equal(sanitizeMailerSettings({ ...FULL_FILE_SETTINGS, password: '' }).passwordSet, false);

  assert.equal(composeFrom({ fromAddress: 'a@b.c', fromName: 'Kikx' }), 'Kikx <a@b.c>');
  assert.equal(composeFrom({ fromAddress: 'a@b.c', fromName: '' }), 'a@b.c');

  const starttls = nodemailerOptionsFrom({ ...FULL_FILE_SETTINGS, tls: 'STARTTLS', port: 587 });
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true, 'STARTTLS = require upgrade');
  assert.equal(starttls.auth.user, 'u@example.com');
  assert.equal(starttls.auth.pass, 'hunter2');

  const ssl = nodemailerOptionsFrom(FULL_FILE_SETTINGS);
  assert.equal(ssl.secure, true, 'SSL = implicit TLS on 465');
  assert.equal(ssl.requireTLS, false);

  const none = nodemailerOptionsFrom({ ...FULL_FILE_SETTINGS, tls: 'none' });
  assert.equal(none.secure, false);
  assert.equal(none.requireTLS, false);
});
