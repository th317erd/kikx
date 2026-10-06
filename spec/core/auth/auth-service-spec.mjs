'use strict';

// Driver-agnostic auth core: user/session/API-key/magic-link stores wired
// through AuthService over the in-memory reference driver. Exercises the full
// magic-link round trip, rotation, revocation and account-state transitions.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthService, publicUser } from '../../../src/core/auth/auth-service.mjs';
import { buildMagicLinkURL, createMailer } from '../../../src/core/auth/mailer.mjs';
import { InMemoryDatabaseConnection } from '../database/reference-driver.mjs';

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (millis) => {
      current += millis;
      return current;
    },
  };
}

function createFakeMailer() {
  let messages = [];
  return {
    messages,
    async sendMagicLink(message) {
      messages.push(message);
    },
  };
}

async function createHarness(options = {}) {
  let db = options.db || new InMemoryDatabaseConnection();
  await db.connect();
  let clock = options.clock || createClock();
  let mailer = options.mailer || createFakeMailer();
  let logger = { info() {}, error() {} };
  let service = createAuthService({
    db,
    clock: clock.now,
    mailer,
    logger,
    publicURL: 'https://kikx.test',
    ...options.serviceOptions,
  });

  return { db, clock, mailer, service };
}

async function issueCode(harness, email, createOptions = {}) {
  await harness.service.users.create({ email, ...createOptions });
  await harness.service.requestMagicLink(email);
  return harness.mailer.messages.at(-1).code;
}

test('createAuthService requires a db (or the aeordb alias)', () => {
  assert.throws(
    () => createAuthService(),
    (error) => error instanceof TypeError && /requires db/.test(error.message),
  );
  assert.doesNotThrow(() => createAuthService({ aeordb: new InMemoryDatabaseConnection() }));
});

test('ensureAdmin creates exactly one admin on an empty store and is a no-op afterwards', async () => {
  let { service } = await createHarness();

  let first = await service.ensureAdmin({ email: 'Root@Example.com', name: 'Root' });
  assert.equal(first.created, true);
  assert.equal(first.user.email, 'root@example.com');
  assert.equal(first.user.name, 'Root');
  assert.deepEqual(first.user.roles, [ 'admin' ]);
  assert.equal(await service.users.count(), 1);

  let second = await service.ensureAdmin({ email: 'other@example.com' });
  assert.equal(second.created, false);
  assert.equal(second.user, null);
  assert.equal(await service.users.count(), 1);
});

test('requestMagicLink for an unknown email returns ok and sends nothing (no enumeration)', async () => {
  let { service, mailer } = await createHarness();

  let result = await service.requestMagicLink('nobody@example.com');
  assert.deepEqual(result, { ok: true });
  assert.equal(mailer.messages.length, 0);
});

test('requestMagicLink for a disabled user sends nothing', async () => {
  let harness = await createHarness();
  let user = await harness.service.users.create({ email: 'off@example.com' });
  await harness.service.updateUser(user.id, { disabled: true });

  assert.deepEqual(await harness.service.requestMagicLink('off@example.com'), { ok: true });
  assert.equal(harness.mailer.messages.length, 0);
});

test('requestMagicLink for a known email sends a link whose URL contains the code', async () => {
  let harness = await createHarness();
  await harness.service.users.create({ email: 'user@example.com' });

  let result = await harness.service.requestMagicLink('User@Example.com', { redirectTo: '/app' });
  assert.deepEqual(result, { ok: true });
  assert.equal(harness.mailer.messages.length, 1);

  let message = harness.mailer.messages[0];
  assert.equal(message.to, 'user@example.com');
  assert.ok(message.url.includes(message.code));
  assert.ok(message.url.startsWith('https://kikx.test/api/v1/auth/magic-link/verify?code='));
  assert.ok(message.url.includes('redirect=%2Fapp'));
  assert.equal(typeof message.expiresAt, 'number');
});

test('full magic-link round trip issues tokens and resolves an admin identity', async () => {
  let harness = await createHarness();
  let code = await issueCode(harness, 'admin@example.com', { roles: [ 'admin' ] });

  let result = await harness.service.verifyMagicLink(code);
  assert.equal(result.user.email, 'admin@example.com');
  assert.deepEqual(result.user.roles, [ 'admin' ]);
  assert.ok(result.token);
  assert.ok(result.refresh_token);
  assert.equal(typeof result.expires_at, 'number');
  assert.notEqual(result.token, result.refresh_token);

  let identity = await harness.service.verifyAccessToken(result.token);
  assert.equal(identity.id, result.user.id);
  assert.equal(identity.email, 'admin@example.com');
  assert.deepEqual(identity.roles, [ 'admin' ]);
  assert.equal(identity.isRoot, true);
  assert.deepEqual(identity.claims, {});
  assert.ok(identity.sessionId);

  assert.equal(await harness.service.getUserByEmail('admin@example.com').then((user) => user.id), result.user.id);
});

test('a consumed magic link cannot be replayed', async () => {
  let harness = await createHarness();
  let code = await issueCode(harness, 'replay@example.com');
  await harness.service.verifyMagicLink(code);

  await assert.rejects(
    () => harness.service.verifyMagicLink(code),
    (error) => error.status === 401 && error.code === 'invalid_magic_link',
  );
});

test('a magic link with an unknown code is rejected', async () => {
  let { service } = await createHarness();

  // Malformed, and well-formed-but-unknown (id absent from the store).
  await assert.rejects(
    () => service.verifyMagicLink('not-a-real-code'),
    (error) => error.status === 401 && error.code === 'invalid_magic_link',
  );
  await assert.rejects(
    () => service.verifyMagicLink(`${'a'.repeat(32)}.whatever`),
    (error) => error.status === 401 && error.code === 'invalid_magic_link',
  );
});

test('an expired magic link is rejected', async () => {
  let harness = await createHarness({ serviceOptions: { magicLinkTTLSeconds: 60 } });
  let code = await issueCode(harness, 'late@example.com');

  harness.clock.advance(60_000);
  await assert.rejects(
    () => harness.service.verifyMagicLink(code),
    (error) => error.status === 401 && error.code === 'invalid_magic_link',
  );
});

test('refresh rotation invalidates the old access and refresh tokens', async () => {
  let harness = await createHarness();
  let code = await issueCode(harness, 'rotate@example.com');
  let first = await harness.service.verifyMagicLink(code);

  let rotated = await harness.service.refreshToken(first.refresh_token);
  assert.notEqual(rotated.token, first.token);
  assert.notEqual(rotated.refresh_token, first.refresh_token);
  assert.equal(rotated.user.id, first.user.id);

  // The new pair works, including another rotation of the new refresh token.
  assert.ok(await harness.service.verifyAccessToken(rotated.token));
  let second = await harness.service.refreshToken(rotated.refresh_token);
  assert.ok(second.token);

  // The superseded access and refresh tokens no longer work.
  assert.equal(await harness.service.verifyAccessToken(first.token), null);
  await assert.rejects(
    () => harness.service.refreshToken(first.refresh_token),
    (error) => error.status === 401 && error.code === 'invalid_refresh_token',
  );
});

test('an expired refresh token is rejected', async () => {
  let harness = await createHarness({ serviceOptions: { refreshTTLSeconds: 120 } });
  let code = await issueCode(harness, 'expiry@example.com');
  let first = await harness.service.verifyMagicLink(code);

  harness.clock.advance(120_000);
  await assert.rejects(
    () => harness.service.refreshToken(first.refresh_token),
    (error) => error.status === 401 && error.code === 'invalid_refresh_token',
  );
});

test('an expired access token does not verify', async () => {
  let harness = await createHarness({ serviceOptions: { accessTTLSeconds: 60 } });
  let code = await issueCode(harness, 'short@example.com');
  let result = await harness.service.verifyMagicLink(code);

  assert.ok(await harness.service.verifyAccessToken(result.token));
  harness.clock.advance(60_000);
  assert.equal(await harness.service.verifyAccessToken(result.token), null);
});

test('a revoked session no longer verifies and revoke is idempotent', async () => {
  let harness = await createHarness();
  let code = await issueCode(harness, 'revoke@example.com');
  let result = await harness.service.verifyMagicLink(code);
  let identity = await harness.service.verifyAccessToken(result.token);

  assert.equal(await harness.service.revokeSession(identity.sessionId), true);
  assert.equal(await harness.service.verifyAccessToken(result.token), null);
  assert.equal(await harness.service.revokeSession(identity.sessionId), false);
});

test('revokeAllSessions kills every session for a user but not other users', async () => {
  let harness = await createHarness();
  let first = await harness.service.users.create({ email: 'multi@example.com' });
  let other = await harness.service.users.create({ email: 'other@example.com' });
  let sessionA = await harness.service.sessions.create({ userId: first.id, accessTTLSeconds: 3600, refreshTTLSeconds: 7200 });
  let sessionB = await harness.service.sessions.create({ userId: first.id, accessTTLSeconds: 3600, refreshTTLSeconds: 7200 });
  let sessionC = await harness.service.sessions.create({ userId: other.id, accessTTLSeconds: 3600, refreshTTLSeconds: 7200 });

  assert.equal(await harness.service.revokeAllSessions(first.id), 2);
  assert.equal(await harness.service.verifyAccessToken(sessionA.token), null);
  assert.equal(await harness.service.verifyAccessToken(sessionB.token), null);
  assert.ok(await harness.service.verifyAccessToken(sessionC.token));
});

test('API keys exchange for sessions, list without secrets, and can be revoked', async () => {
  let harness = await createHarness();
  let user = await harness.service.users.create({ email: 'dev@example.com' });
  let created = await harness.service.createApiKey(user.id, { label: 'laptop' });
  assert.ok(created.apiKey.includes('.'));
  assert.equal(created.key.prefix, created.key.id.slice(0, 8));
  assert.equal(created.apiKey.startsWith(`${created.key.id}.`), true);
  assert.ok(!('secretHash' in created.key));

  let listed = await harness.service.listApiKeys(user.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'laptop');
  assert.ok(!('secretHash' in listed[0]));
  assert.equal(listed[0].lastUsedAt, null);

  let exchanged = await harness.service.exchangeApiKey(created.apiKey);
  assert.equal(exchanged.user.id, user.id);
  assert.ok(await harness.service.verifyAccessToken(exchanged.token));

  let afterUse = await harness.service.listApiKeys(user.id);
  assert.equal(typeof afterUse[0].lastUsedAt, 'number');

  // Another user cannot revoke it.
  let other = await harness.service.users.create({ email: 'other@example.com' });
  assert.equal(await harness.service.revokeApiKey(other.id, created.key.id), false);

  assert.equal(await harness.service.revokeApiKey(user.id, created.key.id), true);
  await assert.rejects(
    () => harness.service.exchangeApiKey(created.apiKey),
    (error) => error.status === 401 && error.code === 'invalid_api_key',
  );
});

test('an API key owned by a disabled user is rejected', async () => {
  let harness = await createHarness();
  let user = await harness.service.users.create({ email: 'dev2@example.com' });
  let created = await harness.service.createApiKey(user.id, { label: 'desktop' });

  await harness.service.updateUser(user.id, { disabled: true });
  await assert.rejects(
    () => harness.service.exchangeApiKey(created.apiKey),
    (error) => error.status === 401 && error.code === 'invalid_api_key',
  );
});

test('an unknown API key is rejected', async () => {
  let { service } = await createHarness();

  await assert.rejects(
    () => service.exchangeApiKey(`${'a'.repeat(32)}.whatever`),
    (error) => error.status === 401 && error.code === 'invalid_api_key',
  );
});

test('a disabled user cannot verify a still-valid access token', async () => {
  let harness = await createHarness();
  let code = await issueCode(harness, 'disable@example.com');
  let result = await harness.service.verifyMagicLink(code);
  assert.ok(await harness.service.verifyAccessToken(result.token));

  await harness.service.updateUser(result.user.id, { disabled: true });
  assert.equal(await harness.service.verifyAccessToken(result.token), null);
});

test('verifyAccessToken returns null for malformed tokens and never throws', async () => {
  let { service } = await createHarness();

  for (let token of [ null, undefined, '', 'garbage', 'not.a.token', 'zzzz' ])
    assert.equal(await service.verifyAccessToken(token), null);
});

test('changing an email moves the index from the old address to the new one', async () => {
  let harness = await createHarness();
  let user = await harness.service.users.create({ email: 'old@example.com' });
  assert.equal((await harness.service.getUserByEmail('old@example.com')).id, user.id);

  await harness.service.updateUser(user.id, { email: 'New@Example.com' });
  assert.equal(await harness.service.getUserByEmail('old@example.com'), null);

  let found = await harness.service.getUserByEmail('new@example.com');
  assert.equal(found.id, user.id);
  assert.equal(found.email, 'new@example.com');
});

test('updateUser throws user_not_found and rejects duplicate emails', async () => {
  let harness = await createHarness();
  await harness.service.users.create({ email: 'taken@example.com' });
  let user = await harness.service.users.create({ email: 'mine@example.com' });

  await assert.rejects(
    () => harness.service.updateUser('missing-id', { name: 'x' }),
    (error) => error.status === 404 && error.code === 'user_not_found',
  );

  await assert.rejects(
    () => harness.service.updateUser(user.id, { email: 'taken@example.com' }),
    (error) => error.status === 409 && error.code === 'email_taken',
  );
});

test('publicUser strips disabled and hash fields', () => {
  let projected = publicUser({
    id: 'u1',
    email: 'u@example.com',
    username: 'u',
    name: 'User',
    roles: [ 'admin' ],
    disabled: true,
    secretHash: 'deadbeef',
    createdAt: 1,
    updatedAt: 2,
  });

  assert.deepEqual(projected, {
    id: 'u1',
    email: 'u@example.com',
    username: 'u',
    name: 'User',
    roles: [ 'admin' ],
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(publicUser(null), null);
});

test('buildMagicLinkURL supports an absolute public URL and an optional redirect', () => {
  assert.equal(
    buildMagicLinkURL({ publicURL: 'https://kikx.test', code: 'a.b' }),
    'https://kikx.test/api/v1/auth/magic-link/verify?code=a.b',
  );
  assert.equal(
    buildMagicLinkURL({ publicURL: 'https://kikx.test/', code: 'a.b', redirectTo: '/home' }),
    'https://kikx.test/api/v1/auth/magic-link/verify?code=a.b&redirect=%2Fhome',
  );
  assert.equal(
    buildMagicLinkURL({ publicURL: '', code: 'a.b' }),
    '/api/v1/auth/magic-link/verify?code=a.b',
  );
});

test('createMailer returns a log mailer by default and rejects a missing smtpUrl', async () => {
  let logged = [];
  let mailer = createMailer({ mode: 'log', log: (message) => logged.push(message) });
  await mailer.sendMagicLink({ to: 'a@b.com', url: 'https://x/y', code: 'c', expiresAt: 1 });
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes('https://x/y'));

  assert.throws(
    () => createMailer({ mode: 'smtp' }),
    (error) => error.status === 500 && error.code === 'smtp_unavailable',
  );
});
