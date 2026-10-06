'use strict';

// The tool-output store is the historical AeorDB search consumer. A driver
// without the search capability now hides `searchFiles`, so the store must fail
// loudly instead of silently returning an empty result set.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolOutputStore } from '../../../src/core/tools/tool-output-store.mjs';
import { InMemoryDatabaseConnection } from '../database/reference-driver.mjs';

test('ToolOutputStore.searchToolOutputs throws when the driver cannot search', async () => {
  let db = new InMemoryDatabaseConnection();
  let store = new ToolOutputStore({ db });

  await assert.rejects(
    () => store.searchToolOutputs({ query: 'hello' }),
    /unsupported by the active database driver/,
  );
});

test('ToolOutputStore.searchToolOutputs delegates to searchFiles when present', async () => {
  let calls = [];
  let db = {
    async configureIndexes(configs) {
      calls.push({ method: 'configureIndexes', configs });
    },
    async searchFiles(search) {
      calls.push({ method: 'searchFiles', search });
      return { items: [ { path: '/kikx/tool-outputs/OUT1/metadata.json' } ], total: 1 };
    },
  };
  let store = new ToolOutputStore({ db });

  let result = await store.searchToolOutputs({ query: 'hello' });

  assert.equal(result.total, 1);
  assert.ok(calls.some((call) => call.method === 'configureIndexes'));
  let searchCall = calls.find((call) => call.method === 'searchFiles');
  assert.equal(searchCall.search.path, '/kikx/tool-outputs');
  assert.equal(searchCall.search.query, 'hello');
});
