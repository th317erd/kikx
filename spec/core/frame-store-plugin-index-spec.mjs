'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionIndexConfigs } from '../../src/core/aeordb/frame-store-indexes.mjs';
import { FrameStore } from '../../src/core/aeordb/frame-store.mjs';

test('plugin frame indexes are merged into the session interaction index without replacing core indexes', () => {
  let configs = buildSessionIndexConfigs('/kikx', 'session_1', [
    { name: 'focus_todo_id', type: 'string' },
  ]);
  let indexes = configs.find((config) => config.path.includes('/interactions/')).body.indexes;

  assert.equal(indexes.some((index) => index.name === 'id'), true);
  assert.deepEqual(indexes.find((index) => index.name === 'focus_todo_id'), {
    name: 'focus_todo_id',
    type: 'string',
  });
});


test('a plugin frame index can be qualified to one driver', () => {
  let store = new FrameStore({
    aeordb: { driverID: 'aeordb' },
    extraSessionIndexes: () => [
      { name: 'postgres_only', type: 'string', drivers: [ 'postgresql' ] },
      { name: 'all_drivers', type: 'string' },
    ],
  });
  let indexes = store.sessionIndexConfigs('session_1')
    .find((config) => config.path.includes('/interactions/')).body.indexes;
  assert.equal(indexes.some((index) => index.name === 'postgres_only'), false);
  assert.equal(indexes.some((index) => index.name === 'all_drivers'), true);
});
