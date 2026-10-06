'use strict';

// AccountStore identity verification gate. verifyIdentity() must fail closed
// for any database driver that does not advertise auth, even if the driver
// exposes a withToken() method.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountStore } from '../../../src/core/account/account-store.mjs';
import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';

const identity = { id: 'user-1', token: 'token-1', isFallback: false, isRoot: false };

test('verifyIdentity returns false when the driver exposes no withToken', async () => {
  let store = new AccountStore({ aeordb: { request() {} } });
  assert.equal(await store.verifyIdentity(identity), false);
});

test('verifyIdentity returns false when the driver declares auth unsupported', async () => {
  class NoAuthDriver extends DatabaseConnectionBase {
    static capabilities = { ...DatabaseConnectionBase.capabilities, auth: false };
    withToken(_token) {
      return { listOwnAPIKeys: async () => ({ keys: [] }) };
    }
  }

  let store = new AccountStore({ aeordb: new NoAuthDriver() });
  assert.equal(await store.verifyIdentity(identity), false);
});

test('verifyIdentity returns false when the scoped client exposes no auth method', async () => {
  class AuthDriver extends DatabaseConnectionBase {
    static capabilities = { ...DatabaseConnectionBase.capabilities, auth: true };
    withToken(_token) {
      return {};
    }
  }

  let store = new AccountStore({ aeordb: new AuthDriver() });
  assert.equal(await store.verifyIdentity(identity), false);
});

test('verifyIdentity calls the scoped client and returns true on success', async () => {
  class AuthDriver extends DatabaseConnectionBase {
    static capabilities = { ...DatabaseConnectionBase.capabilities, auth: true };
    withToken(token) {
      assert.equal(token, identity.token);
      return { listOwnAPIKeys: async () => ({ keys: [] }) };
    }
  }

  let store = new AccountStore({ aeordb: new AuthDriver() });
  assert.equal(await store.verifyIdentity(identity), true);
});

test('verifyIdentity maps a 401 from the scoped client to a sign-in error', async () => {
  class AuthDriver extends DatabaseConnectionBase {
    static capabilities = { ...DatabaseConnectionBase.capabilities, auth: true };
    withToken() {
      return {
        listOwnAPIKeys: async () => {
          let error = new Error('unauthorized');
          error.status = 401;
          throw error;
        },
      };
    }
  }

  let store = new AccountStore({ aeordb: new AuthDriver() });
  await assert.rejects(
    () => store.verifyIdentity(identity),
    (error) => error.status === 401 && /Sign in again/.test(error.message),
  );
});
