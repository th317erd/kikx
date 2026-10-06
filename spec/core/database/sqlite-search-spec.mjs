'use strict';

// SQLite search/query/range contract. SQLite has no searchable text index, so
// these surfaces run over the shared streaming scan fallback (plan §D2):
// candidate narrowing is the indexed path-range scan in entries(), while
// matching, locator construction and range slicing happen in JS. This spec
// proves the scan-backed results match the shape and semantics the indexed
// PostgreSQL path provides.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseError } from '../../../src/core/database/database-error.mjs';
import { SQLiteConnection } from '../../../src/core/database/sqlite-connection.mjs';
import { DatabaseFetchTool } from '../../../src/core/tools/database-tools.mjs';

async function withConnection(fn) {
  let db = new SQLiteConnection({ filename: ':memory:' });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

test('SQLite scan search returns line/byte/fetch locators and content_hash changes on edit', async () => {
  await withConnection(async (db) => {
    let path = '/kikx-sqlite/locator/note.json';
    let body = { kind: 'note', title: 'alpha', body: 'First line\nsecond line needle here\nthird line' };
    await db.put(path, body);

    let content = JSON.stringify(body);
    let needleIndex = content.indexOf('needle');
    assert.ok(needleIndex > 0, 'fixture must contain the probe substring');

    let found = await db.search({ path: '/kikx-sqlite/locator', query: 'needle', include_matches: true });
    assert.equal(found.total_count, 1);
    assert.equal(found.results.length, 1);
    assert.equal(found.has_more, false);

    let entry = found.results[0];
    assert.equal(entry.path, path);
    assert.equal(entry.matched_by[0], 'content');
    assert.equal(typeof entry.content_hash, 'string');
    assert.equal(entry.matches.length, 1);

    let match = entry.matches[0];
    assert.equal(match.matched_text, 'needle');
    assert.equal(match.source, 'content');
    assert.equal(match.field, '@content');
    assert.deepEqual(match.range.line, { start: 1, end: 1, unit: 'line', basis: 'stored-file-text' });
    assert.deepEqual(match.range.byte, {
      start: Buffer.byteLength(content.slice(0, needleIndex), 'utf8'),
      end: Buffer.byteLength(content.slice(0, needleIndex + 'needle'.length), 'utf8'),
      unit: 'utf8-byte',
      basis: 'stored-file',
    });
    assert.equal(match.fetch.preferred, 'line_range');
    assert.deepEqual(match.fetch.line_range, { start: 1, end: 3 });
    assert.ok(match.fetch.byte_range.start <= match.range.byte.start);
    assert.ok(match.fetch.byte_range.end >= match.range.byte.end);
    assert.ok(match.snippet.text.includes('needle'));

    let firstHash = entry.content_hash;
    await db.put(path, { ...body, body: 'A different line needle appears' });
    let updated = await db.search({ path: '/kikx-sqlite/locator', query: 'needle', include_matches: true });
    assert.equal(updated.results.length, 1);
    assert.notEqual(updated.results[0].content_hash, firstHash);
  });
});

test('SQLite scan search locates matches in raw multi-line text', async () => {
  await withConnection(async (db) => {
    let text = 'alpha\nbeta needle here\ngamma\ndelta\n';
    await db.put('/kikx-sqlite/multiline/raw.txt', text, { raw: true });

    let found = await db.search({ path: '/kikx-sqlite/multiline', query: 'needle', include_matches: true });
    assert.equal(found.total_count, 1);

    let entry = found.results[0];
    assert.equal(entry.content_type, 'text/plain');
    let match = entry.matches[0];
    assert.equal(match.matched_text, 'needle');
    assert.equal(match.range.line.start, 2);
    assert.equal(match.range.byte.start, Buffer.byteLength('alpha\nbeta ', 'utf8'));
    assert.deepEqual(match.fetch.line_range, { start: 1, end: 4 });
  });
});

test('SQLite scan search honors the path scope, pagination and include_matches', async () => {
  await withConnection(async (db) => {
    await db.put('/kikx-sqlite/scope/a.json', { title: 'needle a' });
    await db.put('/kikx-sqlite/scope/b.json', { title: 'needle b' });
    await db.put('/kikx-sqlite/other/c.json', { title: 'needle c' });
    await db.put('/kikx-sqlite/scope/nested/d.json', { title: 'needle d' });

    let scoped = await db.search({ path: '/kikx-sqlite/scope', query: 'needle' });
    assert.equal(scoped.total_count, 3, 'recursive descendants only, not the sibling /other path');

    let page = await db.search({
      path: '/kikx-sqlite/scope',
      query: 'needle',
      include_matches: false,
      limit: 1,
      offset: 1,
    });
    assert.equal(page.total_count, 3);
    assert.equal(page.results.length, 1);
    assert.equal(page.has_more, true);
    assert.deepEqual(page.results[0].matches, [], 'include_matches:false suppresses locators');
    assert.equal(page.results[0].locator_status, 'unsupported');
  });
});

test('SQLite structured query supports and/or/not with eq/gt/contains/in and select', async () => {
  await withConnection(async (db) => {
    let docs = [
      { name: 'alpha', kind: 'note', priority: 5, title: 'Alpha Notes' },
      { name: 'beta', kind: 'note', priority: 2, title: 'Beta' },
      { name: 'gamma', kind: 'task', priority: 9, title: 'Gamma' },
    ];
    for (let doc of docs)
      await db.put(`/kikx-sqlite/query/${doc.name}.json`, doc);

    let paths = (result) => result.results.map((item) => item.path).sort();
    let p = (name) => `/kikx-sqlite/query/${name}.json`;

    let eq = await db.query({
      path: '/kikx-sqlite/query',
      where: { field: 'kind', op: 'eq', value: 'note' },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(eq), [ p('alpha'), p('beta') ]);
    assert.equal(eq.total_count, 2);

    let and = await db.query({
      path: '/kikx-sqlite/query',
      where: { and: [
        { field: 'kind', op: 'eq', value: 'note' },
        { field: 'priority', op: 'gt', value: 3 },
      ] },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(and), [ p('alpha') ]);

    let or = await db.query({
      path: '/kikx-sqlite/query',
      where: { or: [
        { field: 'kind', op: 'eq', value: 'task' },
        { field: 'priority', op: 'lte', value: 2 },
      ] },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(or), [ p('beta'), p('gamma') ]);

    let not = await db.query({
      path: '/kikx-sqlite/query',
      where: { not: { field: 'kind', op: 'eq', value: 'note' } },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(not), [ p('gamma') ]);

    let ne = await db.query({
      path: '/kikx-sqlite/query',
      where: { field: 'kind', op: 'ne', value: 'note' },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(ne), [ p('gamma') ]);

    let contains = await db.query({
      path: '/kikx-sqlite/query',
      where: { field: 'title', op: 'contains', value: 'amma' },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(contains), [ p('gamma') ]);

    let prefix = await db.query({
      path: '/kikx-sqlite/query',
      where: { field: 'title', op: 'prefix', value: 'Alpha' },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(prefix), [ p('alpha') ]);

    let inOp = await db.query({
      path: '/kikx-sqlite/query',
      where: { field: 'name', op: 'in', value: [ 'alpha', 'gamma' ] },
      select: [ '@path' ],
    });
    assert.deepEqual(paths(inOp), [ p('alpha'), p('gamma') ]);

    let projected = await db.query({
      path: '/kikx-sqlite/query',
      where: { field: 'name', op: 'eq', value: 'alpha' },
      select: [ '@path', 'priority', 'title' ],
    });
    assert.deepEqual(projected.results, [ { path: p('alpha'), priority: 5, title: 'Alpha Notes' } ]);

    let page = await db.query({
      path: '/kikx-sqlite/query',
      where: { field: 'kind', op: 'exists', value: true },
      select: [ '@path' ],
      limit: 1,
      offset: 1,
    });
    assert.equal(page.total_count, 3);
    assert.equal(page.results.length, 1);
    assert.equal(page.has_more, true);
  });
});

test('SQLite structured query requires where and rejects malformed conditions', async () => {
  await withConnection(async (db) => {
    await assert.rejects(() => db.query({ path: '/kikx-sqlite' }), (error) => error.code === 'invalid_query');
    await assert.rejects(
      () => db.query({ where: { field: 'kind', op: 'nope', value: 1 } }),
      (error) => error.code === 'invalid_query',
    );
    await assert.rejects(
      () => db.query({ where: { field: 'kind', op: 'in', value: 'not-an-array' } }),
      (error) => error.code === 'invalid_query',
    );
  });
});

test('SQLite getRanges slices lines/bytes/chars/json_pointer and 404s on a missing document', async () => {
  await withConnection(async (db) => {
    let text = 'alpha\nbéta\ngamma\ndelta\n';
    let path = '/kikx-sqlite/ranges/text.txt';
    await db.put(path, text, { raw: true });

    let lines = await db.getRanges([ { path, range: { mode: 'lines', start: 2, end: 3 } } ]);
    assert.equal(lines.items[0].status, 'ok');
    assert.equal(lines.items[0].range.mode, 'lines');
    assert.equal(lines.items[0].content, 'béta\ngamma\n');
    assert.equal(lines.items[0].truncated, false);
    assert.equal(typeof lines.items[0].updated_at, 'number');
    assert.equal(typeof lines.items[0].content_hash, 'string');

    let bytesStart = Buffer.byteLength('alpha\n', 'utf8');
    let bytes = await db.getRanges([ {
      path,
      range: { mode: 'bytes', start: bytesStart, end: bytesStart + Buffer.byteLength('béta', 'utf8') },
    } ]);
    assert.equal(bytes.items[0].content, 'béta');

    // `chars` counts Unicode scalars, not UTF-8 bytes: index 6..8 is "bé".
    let chars = await db.getRanges([ { path, range: { mode: 'chars', start: 6, end: 8 } } ]);
    assert.equal(chars.items[0].content, 'bé');

    let jsonPath = '/kikx-sqlite/ranges/doc.json';
    await db.put(jsonPath, { nested: { value: 'deep' } });
    let pointer = await db.getRanges([ { path: jsonPath, range: { mode: 'json_pointer', pointer: '/nested/value' } } ]);
    assert.equal(pointer.items[0].content, 'deep');

    await assert.rejects(
      () => db.getRanges([ { path: '/kikx-sqlite/ranges/missing.txt', range: { mode: 'lines', start: 1, end: 1 } } ]),
      (error) => error instanceof DatabaseError && error.status === 404,
    );

    let partial = await db.getRanges(
      [
        { path, range: { mode: 'lines', start: 1, end: 1 } },
        { path: '/kikx-sqlite/ranges/missing.txt', range: { mode: 'lines', start: 1, end: 1 } },
      ],
      { continueOnError: true },
    );
    assert.equal(partial.has_errors, true);
    assert.equal(partial.items[0].status, 'ok');
    assert.equal(partial.items[1].status, 'not_found');
  });
});

test('SQLite getRanges rejects a stale content hash', async () => {
  await withConnection(async (db) => {
    let path = '/kikx-sqlite/stale/raw.txt';
    await db.put(path, 'hello world', { raw: true });

    let ok = await db.getRanges([ { path, range: { mode: 'lines', start: 1, end: 1 } } ]);
    assert.equal(ok.items[0].status, 'ok');

    let stale = await db.getRanges(
      [ {
        path,
        range: { mode: 'lines', start: 1, end: 1 },
        if_content_hash: 'not-the-hash',
      } ],
      { continueOnError: true },
    );
    assert.equal(stale.has_errors, true);
    assert.equal(stale.items[0].status, 'stale');
  });
});

test('a SQLite scan locator round-trips through DatabaseFetchTool', async () => {
  await withConnection(async (db) => {
    let text = 'line one\nline two has needle\nline three\nline four\n';
    let path = '/kikx-sqlite/roundtrip/raw.txt';
    await db.put(path, text, { raw: true });

    let found = await db.search({ path: '/kikx-sqlite/roundtrip', query: 'needle', include_matches: true });
    let entry = found.results[0];
    let match = entry.matches[0];

    let tool = new DatabaseFetchTool({ services: { aeordb: db } });
    let fetched = await tool.execute({
      items: [ { id: match.id, path: entry.path, fetch: match.fetch, content_hash: entry.content_hash } ],
      continueOnError: true,
    });

    assert.equal(fetched.has_errors, false);
    assert.equal(fetched.items[0].status, 'ok');
    assert.equal(fetched.items[0].range.mode, 'lines');
    assert.equal(fetched.items[0].range.start, 1);
    assert.equal(fetched.items[0].range.end, 4);
    assert.ok(fetched.items[0].content.includes('needle'));
    assert.equal(fetched.items[0].content_hash, entry.content_hash);
  });
});
