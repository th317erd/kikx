'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { registerBuiltInTagDefinitions, TagsStore } from '../../../src/core/tags/index.mjs';
import { FakeAeorDBClient } from '../database/fake-aeordb-client.mjs';

function createStore() {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerBuiltInTagDefinitions(registry);
  let store = new TagsStore({
    db: new FakeAeorDBClient(),
    pluginRegistry: registry,
    clock: () => '2026-10-25T00:00:00.000Z',
  });
  return { registry, store };
}

test('TagsStore creates, reads, lists, updates, and deletes indexed tags', async () => {
  let { store } = createStore();

  let created = await store.createTag({
    target_type: 'agent',
    target_id: 'agent_1',
    name: 'ocr_score',
    value: 7,
  });
  assert.deepEqual(created, {
    target_type: 'agent',
    target_id: 'agent_1',
    name: 'ocr_score',
    value: 7,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
  });

  assert.equal((await store.getTag({
    target_type: 'agent',
    target_id: 'agent_1',
    name: 'ocr_score',
  })).value, 7);

  let listed = await store.listTags({ target_type: 'agent', name: 'ocr_score' });
  assert.equal(listed.total, 1);
  assert.equal(listed.tags[0].target_id, 'agent_1');

  let updated = await store.updateTag({
    target_type: 'agent',
    target_id: 'agent_1',
    name: 'ocr_score',
    value: 9,
  });
  assert.equal(updated.value, 9);

  await store.deleteTag({ target_type: 'agent', target_id: 'agent_1', name: 'ocr_score' });
  await assert.rejects(
    () => store.getTag({ target_type: 'agent', target_id: 'agent_1', name: 'ocr_score' }),
    /Tag not found/,
  );
});

test('TagsStore validates typed definitions and supports arbitrary entities', async () => {
  let { store } = createStore();

  await assert.rejects(
    () => store.createTag({ target_type: 'agent', target_id: 'agent_1', name: 'ocr_score', value: 11 }),
    /must be at most 10/,
  );
  await assert.rejects(
    () => store.createTag({ target_type: 'agent', target_id: 'agent_1', name: 'ocr_score', value: 1.5 }),
    /must be an integer/,
  );

  let sessionTag = await store.createTag({
    target_type: 'session',
    target_id: 'ses_1',
    name: 'review_state',
    value: 'approved',
  });
  assert.equal(sessionTag.target_type, 'session');
  assert.equal((await store.listTags({ target_type: 'session' })).tags[0].value, 'approved');
});

test('TagsStore applyTags upserts values and deletes null values without touching other tags', async () => {
  let { store } = createStore();
  await store.createTag({ target_type: 'agent', target_id: 'agent_1', name: 'ocr_score', value: 3 });
  await store.createTag({ target_type: 'agent', target_id: 'agent_1', name: 'compaction_score', value: 4 });

  await store.applyTags('agent', 'agent_1', [
    { name: 'ocr_score', value: 8 },
    { name: 'compaction_score', value: null },
  ]);

  let result = await store.listTags({ target_type: 'agent', target_id: 'agent_1' });
  assert.deepEqual(result.tags.map((tag) => [ tag.name, tag.value ]), [ [ 'ocr_score', 8 ] ]);
});

test('TagsStore create rejects a duplicate tag', async () => {
  let { store } = createStore();
  let input = { target_type: 'agent', target_id: 'agent_1', name: 'ocr_score', value: 1 };
  await store.createTag(input);
  await assert.rejects(() => store.createTag(input), /already exists/);
});
