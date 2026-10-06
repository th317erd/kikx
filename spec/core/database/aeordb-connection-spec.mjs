'use strict';

// AeorDB driver: runs the shared driver-contract harness against the built-in
// AeorDBConnection (wrapping the in-memory FakeAeorDBClient), then asserts the
// historical file-verb adapters and AeorDB auth passthrough that existing stores
// depend on.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AeorDBConnection } from '../../../src/core/aeordb/aeordb-connection.mjs';
import { AeorDBError } from '../../../src/core/aeordb/aeordb-client.mjs';
import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';
import { runDatabaseContractSuite } from './driver-contract-harness.mjs';
import { FakeAeorDBClient } from './fake-aeordb-client.mjs';

runDatabaseContractSuite('AeorDBConnection', async () => new AeorDBConnection({
  client: new FakeAeorDBClient(),
}), { driverClass: AeorDBConnection });

test('AeorDBConnection extends DatabaseConnectionBase', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  assert.ok(db instanceof DatabaseConnectionBase);
});

test('getFile throws a DatabaseError 404 for a missing document', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  await db.connect();

  try {
    await assert.rejects(
      () => db.getFile('/kikx/test/missing.json'),
      (error) => error instanceof DatabaseError && error.status === 404 && error.code === 'not_found',
    );
  } finally {
    await db.close();
  }
});

test('getFile round-trips a document', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  await db.connect();

  try {
    await db.putFile('/kikx/test/doc.json', { id: 'doc-1', nested: { value: 42 } });
    assert.deepEqual(await db.getFile('/kikx/test/doc.json'), { id: 'doc-1', nested: { value: 42 } });
  } finally {
    await db.close();
  }
});

test('listDirectory({ depth: -1 }) walks recursively and returns { items:[{path}] }', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  await db.connect();

  try {
    await db.putFile('/kikx/list/ses_1/frames/0001.json', { n: 1 });
    await db.putFile('/kikx/list/ses_1/session.json', { id: 'ses_1' });

    let page = await db.listDirectory('/kikx/list/ses_1', { depth: -1, glob: '**/*.json' });
    assert.deepEqual(page.items, [
      { path: '/kikx/list/ses_1/frames/0001.json' },
      { path: '/kikx/list/ses_1/session.json' },
    ]);
    assert.equal(page.total, 2);
  } finally {
    await db.close();
  }
});

test('fetchFiles returns documents keyed by the requested path', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  await db.connect();

  try {
    await db.putFile('/kikx/many/a.json', { id: 'a' });
    let result = await db.fetchFiles([ '/kikx/many/a.json' ]);

    assert.deepEqual(Object.keys(result), [ '/kikx/many/a.json' ]);
    assert.deepEqual(JSON.parse(result['/kikx/many/a.json'].content), { id: 'a' });
  } finally {
    await db.close();
  }
});

test('withToken returns a new AeorDBConnection wrapping a token-scoped client', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  await db.connect();

  try {
    let scoped = db.withToken('scoped-token');

    assert.notEqual(scoped, db);
    assert.ok(scoped instanceof AeorDBConnection);
    assert.equal(scoped.client.token, 'scoped-token');
    assert.equal(scoped.context, db.context);
  } finally {
    await db.close();
  }
});

test('auth passthrough delegates listOwnAPIKeys to the underlying client', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });

  assert.deepEqual(await db.listOwnAPIKeys(), { keys: [] });
  assert.deepEqual(await db.withToken('tok').listOwnAPIKeys(), { keys: [] });
});

test('an auth passthrough method on an incompatible client throws a clear error', () => {
  let db = new AeorDBConnection({ client: {} });

  assert.throws(
    () => db.listOwnAPIKeys(),
    /client does not support listOwnAPIKeys\(\)/,
  );
});

test('merge() on a missing document throws DatabaseError, not AeorDBError', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  await db.connect();

  try {
    await assert.rejects(
      () => db.merge('/kikx/test/absent.json', { a: 1 }),
      (error) => error instanceof DatabaseError
        && !(error instanceof AeorDBError)
        && error.status === 404
        && error.code === 'not_found',
    );
  } finally {
    await db.close();
  }
});

test('configureIndexes writes each index document through the client', async () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  await db.connect();

  try {
    await db.configureIndexes([
      {
        path: '/kikx/agents/.aeordb-config/indexes.json',
        body: { glob: '*/agent.json', indexes: [ { name: 'id', type: 'string' } ] },
      },
      {
        path: '/kikx/teams/.aeordb-config/indexes.json',
        body: { glob: '*/team.json', indexes: [] },
      },
    ]);

    assert.deepEqual(await db.getFile('/kikx/agents/.aeordb-config/indexes.json'), {
      glob: '*/agent.json',
      indexes: [ { name: 'id', type: 'string' } ],
    });
    assert.deepEqual(await db.getFile('/kikx/teams/.aeordb-config/indexes.json'), {
      glob: '*/team.json',
      indexes: [],
    });
  } finally {
    await db.close();
  }
});
