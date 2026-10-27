'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeWhereClause } from '../../../src/core/database/where-clause.mjs';
import {
  DatabaseSearchTool,
  createLocatorSearchRequest,
  formatSearchResponse,
} from '../../../src/core/tools/database-tools.mjs';

test('canonical where conditions pass through', () => {
  assert.deepEqual(normalizeWhereClause({ field: 'authorType', op: 'eq', value: 'user' }), {
    field: 'authorType',
    op: 'eq',
    value: 'user',
  });
});

test('shorthand field and operator-object forms normalize to the same condition', () => {
  for (let where of [
    { authorType: 'user' },
    { authorType: { eq: 'user' } },
    { authorType: { $eq: 'user' } },
  ]) {
    assert.deepEqual(normalizeWhereClause(where), {
      field: 'authorType',
      op: 'eq',
      value: 'user',
    });
  }
});

test('multiple shorthand fields become an AND group', () => {
  assert.deepEqual(normalizeWhereClause({
    authorType: { eq: 'user' },
    createdAt: { gt: 1793118300000000 },
  }), {
    and: [
      { field: 'authorType', op: 'eq', value: 'user' },
      { field: 'createdAt', op: 'gt', value: 1793118300000000 },
    ],
  });
});

test('and, or, and not groups normalize recursively', () => {
  assert.deepEqual(normalizeWhereClause({
    and: [
      { authorType: 'user' },
      { not: { type: { eq: 'UserDraft' } } },
    ],
  }), {
    and: [
      { field: 'authorType', op: 'eq', value: 'user' },
      { not: { field: 'type', op: 'eq', value: 'UserDraft' } },
    ],
  });
});

test('string conditions accept the forms models actually try', () => {
  assert.deepEqual(normalizeWhereClause('authorType=eq user, createdAt=gt 1793118300000000'), {
    and: [
      { field: 'authorType', op: 'eq', value: 'user' },
      { field: 'createdAt', op: 'gt', value: 1793118300000000 },
    ],
  });
  assert.deepEqual(normalizeWhereClause('createdAt=gt:1793120000000000'), {
    field: 'createdAt',
    op: 'gt',
    value: 1793120000000000,
  });
});

test('an expression passed as query is surfaced as a warning, not silently treated as a filter', () => {
  let request = createLocatorSearchRequest({
    path: '/kikx',
    query: 'authorType=eq user, createdAt=gt 1793118300000000',
  });
  let response = formatSearchResponse({ results: [], total_count: 0 }, {
    path: request.path,
    query: request.query,
    where: request.where,
  });

  assert.equal(response.where, null);
  assert.equal(response.warnings.length, 1);
  assert.match(response.warnings[0], /pass it as where/);
});

test('malformed where input fails with the accepted shapes', () => {
  assert.throws(
    () => normalizeWhereClause({ authorType: { nope: 'user' } }),
    /unsupported where operator: nope.*where accepts/,
  );
  assert.throws(
    () => normalizeWhereClause('not a condition'),
    /is not understood.*where accepts/,
  );
  assert.throws(
    () => normalizeWhereClause({}),
    /where must contain at least one condition/,
  );
});


test('DatabaseSearchTool normalizes shorthand where and warns when an expression is passed as query', async () => {
  let requests = [];
  let tool = new DatabaseSearchTool({
    aeordb: {
      async searchFiles(request) {
        requests.push(request);
        return { results: [], total_count: 0 };
      },
    },
  });

  let filtered = await tool.execute({ where: { authorType: 'user', createdAt: { gt: 10 } } });
  assert.deepEqual(requests[0].where, {
    and: [
      { field: 'authorType', op: 'eq', value: 'user' },
      { field: 'createdAt', op: 'gt', value: 10 },
    ],
  });
  assert.equal(filtered.where.and.length, 2);
  assert.equal(filtered.warnings, undefined);

  let textual = await tool.execute({ query: 'authorType=eq user, createdAt=gt 10' });
  assert.equal(requests[1].where, undefined);
  assert.equal(textual.where, null);
  assert.equal(textual.warnings.length, 1);
  assert.match(textual.warnings[0], /pass it as where/);
});
