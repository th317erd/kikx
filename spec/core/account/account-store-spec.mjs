'use strict';

// AccountStore over the Kikx-native AuthService. Identity, name and email come
// from the auth user record; the profile document only carries presentation
// fields. These specs use a fake authService and a fake document db so the
// store's own projection and 401 gates are exercised without any driver.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountStore } from '../../../src/core/account/account-store.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';

const PROFILE_PATH = '/kikx/users/usr_1/profile.json';

function createFakeAuthService({ identities = new Map(), users = new Map() } = {}) {
  let calls = { getUser: [], updateUser: [] };
  return {
    calls,
    identities,
    users,
    async verifyAccessToken(token) {
      return identities.get(token) || null;
    },
    async getUser(id) {
      calls.getUser.push(id);
      return users.get(id) || null;
    },
    async updateUser(id, patch) {
      calls.updateUser.push({ id, patch });
      let next = { ...(users.get(id) || {}), ...patch, id };
      users.set(id, next);
      return next;
    },
  };
}

function createFakeDb(documents = {}, { missingMode = 'throw' } = {}) {
  let store = new Map(Object.entries(documents));
  let writes = [];
  return {
    writes,
    async get(path) {
      if (store.has(path))
        return store.get(path);

      if (missingMode === 'null')
        return null;

      throw DatabaseError.notFound(path);
    },
    async put(path, body) {
      store.set(path, body);
      writes.push({ path, body });
      return { path };
    },
  };
}

function identityFor(id, token) {
  return {
    id,
    sessionId: `sess_${id}`,
    email: `${id}@example.com`,
    roles: [ 'user' ],
    isRoot: false,
    token,
  };
}

test('constructor requires a db and an authService', () => {
  let authService = createFakeAuthService();
  assert.throws(
    () => new AccountStore({ authService }),
    (error) => error instanceof TypeError && /requires db/.test(error.message),
  );
  assert.throws(
    () => new AccountStore({ db: createFakeDb() }),
    (error) => error instanceof TypeError && /requires authService/.test(error.message),
  );
  assert.doesNotThrow(() => new AccountStore({ aeordb: createFakeDb(), authService }));
});

test('resolveIdentity rejects a request without a bearer token', async () => {
  let store = new AccountStore({ db: createFakeDb(), authService: createFakeAuthService() });

  await assert.rejects(
    () => store.resolveIdentity({ headers: {} }),
    (error) => error.status === 401 && error.message === 'Sign in before opening account settings',
  );
});

test('resolveIdentity rejects a token the auth service does not verify', async () => {
  let store = new AccountStore({ db: createFakeDb(), authService: createFakeAuthService() });

  await assert.rejects(
    () => store.resolveIdentity({ headers: { authorization: 'Bearer revoked-token' } }),
    (error) => error.status === 401 && error.message === 'Sign in again before opening account settings',
  );
});

test('resolveIdentity returns the verified identity plus the raw token', async () => {
  let identity = { id: 'usr_1', sessionId: 'sess_1', email: 'usr_1@example.com', roles: [ 'admin' ], isRoot: true };
  let authService = createFakeAuthService({ identities: new Map([ [ 'token-1', identity ] ]) });
  let store = new AccountStore({ db: createFakeDb(), authService });

  let resolved = await store.resolveIdentity({ headers: { authorization: 'Bearer token-1' } });

  assert.deepEqual(resolved, { ...identity, token: 'token-1' });
});

test('getAccount merges the Kikx user record with the profile document', async () => {
  let authService = createFakeAuthService({
    users: new Map([ [ 'usr_1', {
      id: 'usr_1',
      name: 'User Name',
      username: 'wyatt',
      email: 'user@example.com',
      createdAt: 111,
      updatedAt: 222,
    } ] ]),
  });
  let db = createFakeDb({
    [PROFILE_PATH]: {
      id: 'usr_1',
      name: 'Profile Name',
      email: 'profile@example.com',
      createdAt: 100,
      updatedAt: 150,
    },
  });
  let store = new AccountStore({ db, authService });

  let account = await store.getAccount(identityFor('usr_1', 'token-1'));

  assert.deepEqual(account, {
    id: 'usr_1',
    name: 'Profile Name',
    email: 'profile@example.com',
    username: 'wyatt',
    source: 'kikx-user',
    createdAt: 100,
    updatedAt: 150,
  });
});

test('getAccount falls back to the auth user when no profile exists', async () => {
  let authService = createFakeAuthService({
    users: new Map([ [ 'usr_1', {
      id: 'usr_1',
      name: 'User Name',
      username: 'wyatt',
      email: 'user@example.com',
      createdAt: 111,
      updatedAt: 222,
    } ] ]),
  });
  let store = new AccountStore({ db: createFakeDb({}, { missingMode: 'null' }), authService });

  let account = await store.getAccount(identityFor('usr_1', 'token-1'));

  assert.equal(account.name, 'User Name');
  assert.equal(account.email, 'user@example.com');
  assert.deepEqual(account, {
    id: 'usr_1',
    name: 'User Name',
    email: 'user@example.com',
    username: 'wyatt',
    source: 'kikx-user',
    createdAt: 111,
    updatedAt: 222,
  });
});

test('loadProfile treats a DatabaseError 404 as a missing profile', async () => {
  let store = new AccountStore({
    db: createFakeDb({}, { missingMode: 'throw' }),
    authService: createFakeAuthService(),
  });

  assert.equal(await store.loadProfile('usr_1'), null);
});

test('updateAccount writes the profile and forwards name/email to authService.updateUser', async () => {
  let authService = createFakeAuthService({
    users: new Map([ [ 'usr_1', { id: 'usr_1', name: 'Old Name', email: 'old@example.com' } ] ]),
  });
  let db = createFakeDb({
    [PROFILE_PATH]: { id: 'usr_1', name: 'Old Name', email: 'old@example.com', createdAt: 100 },
  });
  let store = new AccountStore({ db, authService, clock: () => 5000 });

  let account = await store.updateAccount(identityFor('usr_1', 'token-1'), {
    name: 'New Name',
    email: 'new@example.com',
  });

  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].path, PROFILE_PATH);
  assert.equal(db.writes[0].body.name, 'New Name');
  assert.equal(db.writes[0].body.email, 'new@example.com');
  assert.equal(db.writes[0].body.createdAt, 100);
  assert.equal(db.writes[0].body.updatedAt, 5000);
  assert.deepEqual(authService.calls.updateUser, [
    { id: 'usr_1', patch: { name: 'New Name', email: 'new@example.com' } },
  ]);
  assert.equal(account.name, 'New Name');
  assert.equal(account.email, 'new@example.com');
  assert.equal(account.source, 'kikx-user');
});

test('updateAccount forwards only the changed fields present in the patch', async () => {
  let authService = createFakeAuthService({
    users: new Map([ [ 'usr_1', { id: 'usr_1', name: 'Old Name', email: 'old@example.com' } ] ]),
  });
  let store = new AccountStore({ db: createFakeDb(), authService, clock: () => 6000 });

  await store.updateAccount(identityFor('usr_1', 'token-1'), { name: 'New Name' });

  assert.deepEqual(authService.calls.updateUser, [
    { id: 'usr_1', patch: { name: 'New Name' } },
  ]);
});

test('updateAccount validates the patch before writing anything', async () => {
  let authService = createFakeAuthService();
  let db = createFakeDb();
  let store = new AccountStore({ db, authService });

  await assert.rejects(
    () => store.updateAccount(identityFor('usr_1', 'token-1'), { email: 'not-an-email' }),
    (error) => error.status === 400 && /valid email/.test(error.message),
  );
  await assert.rejects(
    () => store.updateAccount(identityFor('usr_1', 'token-1'), { name: 'x'.repeat(121) }),
    (error) => error.status === 400 && /120 characters/.test(error.message),
  );
  await assert.rejects(
    () => store.updateAccount(identityFor('usr_1', 'token-1'), {}),
    (error) => error.status === 400 && /At least one account field/.test(error.message),
  );
  assert.equal(db.writes.length, 0);
  assert.deepEqual(authService.calls.updateUser, []);
});

test('verifyIdentity returns true for a verified token and false otherwise', async () => {
  let authService = createFakeAuthService({
    identities: new Map([ [ 'token-1', identityFor('usr_1', 'token-1') ] ]),
  });
  let store = new AccountStore({ db: createFakeDb(), authService });

  assert.equal(await store.verifyIdentity({ token: 'token-1' }), true);
  assert.equal(await store.verifyIdentity({ token: 'token-2' }), false);
  assert.equal(await store.verifyIdentity(null), false);
});
