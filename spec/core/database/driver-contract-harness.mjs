'use strict';

// Shared driver-contract harness.
//
// Every driver (in-memory reference, AeorDB, PostgreSQL, SQLite) runs this
// SAME suite. A driver is exercised through `runDatabaseContractSuite`, which
// creates a fresh connection per test and tears it down. This is the single
// oracle for "is this a valid DatabaseConnectionBase implementation?".
//
// Design rules enforced here:
//  - Required methods exist and are async where the contract says so.
//  - 404 is surfaced as a `DatabaseError` with `status === 404` (not null) for
//    single-document operations, while `get` returns null for a missing doc.
//  - `list` returns `{ items:[{path}], total }` with stable basename order,
//    recursive glob, and pagination.
//  - `entries()` streams (AsyncIterable) and never needs a whole-table array.
//  - `batch()` is ordered and all-or-nothing (a driver may declare
//    `static batchAtomicity = 'best-effort'` to document non-transactional
//    batching; the harness then asserts only that the error surfaces).
//  - Capability flags gate optional methods.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';

export const REQUIRED_METHODS = [
  'connect',
  'close',
  'put',
  'get',
  'merge',
  'delete',
  'list',
  'entries',
  'getMany',
  'batch',
];

export const REQUIRED_CAPABILITIES = [
  'read',
  'write',
  'mergePatch',
  'list',
  'getMany',
  'search',
  'query',
  'events',
  'auth',
  'ranges',
];

// Run the full contract against a driver factory.
//
// factory() -> Promise<DatabaseConnectionBase> | DatabaseConnectionBase
//   A freshly connected driver with its own isolated backing store.
export function runDatabaseContractSuite(label, factory, options = {}) {
  let describe = options.describe || ((name, fn) => test(`${label}: ${name}`, fn));
  let driverClass = options.driverClass || factory.driverClass || null;
  if (!driverClass) {
    throw new TypeError(
      `${label}: runDatabaseContractSuite requires options.driverClass (or factory.driverClass) so capability gating is never silently disabled`,
    );
  }

  // A capability is supported only when the driver explicitly declares `true`,
  // matching DatabaseConnectionBase.supports(). An omitted/undefined capability
  // is off, not optimistically on.
  let hasCapability = (capability) => driverClass.capabilities?.[capability] === true;

  // Drivers default to transactional batch. A driver whose backend cannot
  // provide atomic multi-write must declare `static batchAtomicity =
  // 'best-effort'`; the harness then skips only the rollback assertions while
  // still requiring the error to surface.
  let bestEffortBatch = driverClass.batchAtomicity === 'best-effort';

  describe('extends DatabaseConnectionBase', async () => {
    let db = await factory();
    try {
      assert.ok(db instanceof DatabaseConnectionBase, 'driver must extend DatabaseConnectionBase');
      assert.equal(db.constructor, driverClass, 'factory must return an instance of options.driverClass');
    } finally {
      await db.close();
    }
  });

  describe('declares the required capabilities', async () => {
    for (let capability of REQUIRED_CAPABILITIES)
      assert.equal(typeof driverClass.capabilities?.[capability], 'boolean', `capabilities.${capability} must be a boolean`);

    assert.ok(
      [ 'atomic', 'best-effort' ].includes(driverClass.batchAtomicity),
      `batchAtomicity must be "atomic" or "best-effort", got: ${driverClass.batchAtomicity}`,
    );
  });

  describe('exposes every required method', async () => {
    let db = await factory();
    try {
      for (let method of REQUIRED_METHODS)
        assert.equal(typeof db[method], 'function', `missing method: ${method}`);
    } finally {
      await db.close();
    }
  });

  describe('connect() is idempotent and close() is safe to repeat', async () => {
    let db = await factory();
    await db.connect();
    await db.connect();
    await db.close();
    await db.close();
  });

  if (hasCapability('read') && hasCapability('write')) {
    describe('put/get round-trips JSON documents', async () => {
      let db = await factory();
      try {
        await db.put('/kikx/test/doc.json', { id: 'doc-1', nested: { value: 42 } });
        assert.deepEqual(await db.get('/kikx/test/doc.json'), { id: 'doc-1', nested: { value: 42 } });
      } finally {
        await db.close();
      }
    });

    describe('get() returns null for a missing document (404 is not thrown)', async () => {
      let db = await factory();
      try {
        assert.equal(await db.get('/kikx/test/missing.json'), null);
      } finally {
        await db.close();
      }
    });

    describe('put() accepts a leading slash or none (path normalization)', async () => {
      let db = await factory();
      try {
        await db.put('/kikx/test/norm.json', { ok: true });
        assert.deepEqual(await db.get('kikx/test/norm.json'), { ok: true });
      } finally {
        await db.close();
      }
    });

    describe('a missing required path argument throws a TypeError', async () => {
      let db = await factory();
      try {
        await assert.rejects(() => db.put('', { x: 1 }), TypeError);
        await assert.rejects(() => db.get(''), TypeError);
      } finally {
        await db.close();
      }
    });
  }

  if (hasCapability('write')) {
    describe('delete() removes a document and a second delete reports 404', async () => {
      let db = await factory();
      try {
        await db.put('/kikx/test/gone.json', { id: 'gone' });
        await db.delete('/kikx/test/gone.json');
        assert.equal(await db.get('/kikx/test/gone.json'), null);
        await assert.rejects(
          () => db.delete('/kikx/test/gone.json'),
          (error) => error instanceof DatabaseError && error.status === 404,
        );
      } finally {
        await db.close();
      }
    });
  }

  if (hasCapability('mergePatch')) {
    describe('merge() is RFC-7386 (recursive; null deletes)', async () => {
      let db = await factory();
      try {
        await db.put('/kikx/test/merge.json', { a: 1, keep: true, nested: { x: 1, y: 2 } });
        await db.merge('/kikx/test/merge.json', { b: 2, nested: { y: null, z: 3 } });
        assert.deepEqual(await db.get('/kikx/test/merge.json'), {
          a: 1,
          keep: true,
          b: 2,
          nested: { x: 1, z: 3 },
        });
      } finally {
        await db.close();
      }
    });

    describe('merge() on a missing document reports 404', async () => {
      let db = await factory();
      try {
        await assert.rejects(
          () => db.merge('/kikx/test/absent.json', { a: 1 }),
          (error) => error instanceof DatabaseError && error.status === 404,
        );
      } finally {
        await db.close();
      }
    });
  }

  if (hasCapability('list')) {
    describe('list() is recursive-glob, basename-ordered, and paginates with total', async () => {
      let db = await factory();
      try {
        for (let name of [ '0002.json', '0001.json', '0003.json' ])
          await db.put(`/kikx/list/ses_1/frames/${name}`, { name });
        await db.put('/kikx/list/ses_1/session.json', { id: 'ses_1' });
        await db.put('/kikx/list/ses_2/frames/0001.json', { name: 'other' });

        let page = await db.list('/kikx/list/ses_1', { recursive: true, glob: '**/*.json', limit: 10, offset: 0 });
        assert.deepEqual(
          page.items.map((item) => item.path),
          [ '/kikx/list/ses_1/frames/0001.json', '/kikx/list/ses_1/frames/0002.json', '/kikx/list/ses_1/frames/0003.json', '/kikx/list/ses_1/session.json' ],
        );
        assert.equal(page.total, 4);

        let second = await db.list('/kikx/list/ses_1', { recursive: true, glob: '**/*.json', limit: 2, offset: 2 });
        assert.deepEqual(second.items.map((item) => item.path), [ '/kikx/list/ses_1/frames/0003.json', '/kikx/list/ses_1/session.json' ]);
        assert.equal(second.total, 4);

        let offsetPastEnd = await db.list('/kikx/list/ses_1', { recursive: true, glob: '**/*.json', limit: 10, offset: 99 });
        assert.deepEqual(offsetPastEnd.items, []);
        assert.equal(offsetPastEnd.total, 4);
      } finally {
        await db.close();
      }
    });

    describe('list() is non-recursive when recursive is false', async () => {
      let db = await factory();
      try {
        await db.put('/kikx/one/a.json', { a: 1 });
        await db.put('/kikx/one/deep/b.json', { b: 1 });

        let page = await db.list('/kikx/one', { recursive: false, glob: '*.json' });
        assert.deepEqual(page.items.map((item) => item.path), [ '/kikx/one/a.json' ]);
        assert.equal(page.total, 1);
      } finally {
        await db.close();
      }
    });

    describe('list() on an empty prefix returns no items with total 0', async () => {
      let db = await factory();
      try {
        let page = await db.list('/kikx/nothing/here', { recursive: true, glob: '**/*.json' });
        assert.deepEqual(page.items, []);
        assert.equal(page.total, 0);
      } finally {
        await db.close();
      }
    });

    // Regression: the root prefix is the only one where the `base + '/'` bound
    // and the `base.length + 1` relative slice do not apply, so it needs its own
    // coverage. Assert membership (not exact totals) because the target may hold
    // documents outside the prefixes this suite owns.
    describe('list() and entries() enumerate descendants of the root prefix', async () => {
      let db = await factory();
      try {
        await db.put('/kikx/rootcheck/a.json', { a: 1 });
        await db.put('/kikx/rootcheck/deep/b.json', { b: 1 });

        let page = await db.list('/', { recursive: true, glob: '**/rootcheck/**/*.json' });
        let listed = page.items.map((item) => item.path);
        assert.ok(listed.includes('/kikx/rootcheck/a.json'), 'root list() must include shallow descendants');
        assert.ok(listed.includes('/kikx/rootcheck/deep/b.json'), 'root list() must include deep descendants');

        let flat = await db.list('/', { recursive: false, glob: '**' });
        assert.ok(
          !flat.items.some((item) => item.path === '/kikx/rootcheck/a.json'),
          'root non-recursive list() must not include nested descendants',
        );

        let streamed = [];
        for await (let entry of db.entries('/', { recursive: true }))
          streamed.push(entry.path);

        assert.ok(streamed.includes('/kikx/rootcheck/a.json'), 'root entries() must include shallow descendants');
        assert.ok(streamed.includes('/kikx/rootcheck/deep/b.json'), 'root entries() must include deep descendants');
      } finally {
        await db.close();
      }
    });
  }

  describe('entries() streams {path} objects and never materializes the full table', async () => {
    let db = await factory();
    try {
      for (let index = 0; index < 25; index++)
        await db.put(`/kikx/stream/frames/${String(index).padStart(4, '0')}.json`, { index });

      let iterable = db.entries('/kikx/stream', { recursive: true, glob: '**/*.json' });
      assert.ok(iterable && typeof iterable[Symbol.asyncIterator] === 'function', 'entries() must return an AsyncIterable');

      let seen = 0;
      for await (let entry of iterable) {
        assert.equal(typeof entry.path, 'string');
        seen++;
        if (seen === 3)
          break;
      }

      assert.equal(seen, 3, 'entries() should yield incrementally so a consumer can stop early');
    } finally {
      await db.close();
    }
  });

  if (hasCapability('getMany')) {
    describe('getMany() returns documents keyed by the requested path', async () => {
      let db = await factory();
      try {
        await db.put('/kikx/many/a.json', { id: 'a' });
        await db.put('/kikx/many/b.json', { id: 'b' });

        let result = await db.getMany([ '/kikx/many/a.json', '/kikx/many/b.json' ]);
        assert.deepEqual(JSON.parse(result['/kikx/many/a.json'].content), { id: 'a' });
        assert.deepEqual(JSON.parse(result['/kikx/many/b.json'].content), { id: 'b' });
      } finally {
        await db.close();
      }
    });
  }

  describe('batch() applies operations in order and is all-or-nothing', async () => {
    let db = await factory();
    try {
      await db.put('/kikx/batch/seed.json', { order: 0 });
      await db.batch([
        { type: 'put', path: '/kikx/batch/one.json', body: { order: 1 } },
        { type: 'put', path: '/kikx/batch/two.json', body: { order: 2 } },
        { type: 'merge', path: '/kikx/batch/seed.json', body: { merged: true } },
      ]);

      assert.deepEqual(await db.get('/kikx/batch/one.json'), { order: 1 });
      assert.deepEqual(await db.get('/kikx/batch/two.json'), { order: 2 });
      assert.deepEqual(await db.get('/kikx/batch/seed.json'), { order: 0, merged: true });

      // A failing operation must roll the whole batch back. The failing batch
      // both creates a new document and modifies an existing one before it
      // errors, so a non-atomic driver is caught. A driver with a
      // non-transactional backend opts out by declaring
      // `static batchAtomicity = 'best-effort'` but must still surface the
      // error.
      await assert.rejects(
        () => db.batch([
          { type: 'put', path: '/kikx/batch/three.json', body: { order: 3 } },
          { type: 'merge', path: '/kikx/batch/one.json', body: { rolledBack: true } },
          { type: 'merge', path: '/kikx/batch/does-not-exist.json', body: { x: 1 } },
        ]),
        (error) => error instanceof DatabaseError,
      );

      if (!bestEffortBatch) {
        assert.equal(await db.get('/kikx/batch/three.json'), null, 'failed batch must not leave a newly created document');
        assert.deepEqual(await db.get('/kikx/batch/one.json'), { order: 1 }, 'failed batch must not apply in-batch modifications');
      }
    } finally {
      await db.close();
    }
  });

  describe('batch() rejects a malformed operations argument', async () => {
    let db = await factory();
    try {
      await assert.rejects(() => db.batch(null), TypeError);
      await assert.rejects(() => db.batch([ 'not-an-operation' ]), TypeError);
    } finally {
      await db.close();
    }
  });

  describe('DatabaseError preserves status and code across the boundary', async () => {
    // Structural assertion: the error type is exported from a module that does
    // not import AeorDB, so callers never need AeorDB to catch 404s.
    let error = new DatabaseError('nope', { status: 404, code: 'not_found' });
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'DatabaseError');
    assert.equal(error.status, 404);
    assert.equal(error.code, 'not_found');
    assert.equal(error.notFound, true);
  });
}
