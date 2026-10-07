'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentTodoStore } from '../../../src/core/agents/index.mjs';

test('AgentTodoStore creates, updates, focuses, completes, and deletes per-agent todos', async () => {
  let aeordb = createClient();
  let now = 1000;
  let ids = [ 'todo_1', 'todo_2' ];
  let store = new AgentTodoStore({
    aeordb,
    clock: () => now++,
    idGenerator: () => ids.shift(),
  });

  let empty = await store.getTodoState('agent_1');
  assert.deepEqual(empty.items, []);
  assert.equal(empty.focus, null);

  let withParent = await store.addItem('agent_1', {
    title: 'Build todo feature',
    notes: 'Keep one-level children only.',
    focus: true,
  });
  assert.equal(withParent.items.length, 1);
  assert.equal(withParent.items[0].id, 'todo_1');
  assert.equal(withParent.focus.name, 'Build todo feature');

  let withChild = await store.addItem('agent_1', {
    parentID: 'todo_1',
    title: 'Add tool coverage',
  });
  assert.equal(withChild.items[0].children.length, 1);
  assert.equal(withChild.items[0].children[0].id, 'todo_2');

  let updated = await store.updateItem('agent_1', {
    id: 'todo_2',
    parentID: 'todo_1',
    title: 'Add focused tool coverage',
    status: 'complete',
  });
  assert.equal(updated.items[0].children[0].title, 'Add focused tool coverage');
  assert.equal(updated.items[0].children[0].status, 'complete');
  assert.ok(updated.items[0].children[0].completedAt);

  let focused = await store.setFocus('agent_1', {
    id: 'todo_2',
    parentID: 'todo_1',
  });
  assert.equal(focused.focus.itemID, 'todo_1');
  assert.equal(focused.focus.childID, 'todo_2');
  assert.equal(focused.focus.name, 'Add focused tool coverage');
  assert.equal(typeof focused.focus.setAt, 'number');

  let deleted = await store.deleteItem('agent_1', { id: 'todo_2' });
  assert.equal(deleted.items[0].children.length, 0);
  assert.equal(deleted.focus, null);
  // The removed item rides on the returned object so a result summary can name
  // it, but it must not be persisted.
  assert.equal(deleted.deleted.id, 'todo_2');
  assert.equal(deleted.deleted.title, 'Add focused tool coverage');
  let persisted = aeordb.files.get('/kikx/agents/agent_1/todo.json');
  assert.ok(!('deleted' in persisted), 'deleted must not be written to disk');
  assert.equal(persisted.items[0].children.length, 0);

  let cleared = await store.clearTodoState('agent_1');
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.focus, null);
  assert.deepEqual(aeordb.files.get('/kikx/agents/agent_1/todo.json').items, []);
});

test('AgentTodoStore.deleteItem reports the removed top-level item without persisting it', async () => {
  let aeordb = createClient();
  let ids = [ 'todo_1', 'todo_2' ];
  let store = new AgentTodoStore({
    aeordb,
    idGenerator: () => ids.shift(),
  });

  await store.addItem('agent_1', { title: 'Keep me' });
  await store.addItem('agent_1', { title: 'Delete me' });

  let deleted = await store.deleteItem('agent_1', { id: 'todo_2' });

  assert.deepEqual(deleted.items.map((item) => item.id), [ 'todo_1' ]);
  assert.equal(deleted.deleted.id, 'todo_2');
  assert.equal(deleted.deleted.title, 'Delete me');
  // Same object stripped of the extra key when serialized to the store.
  let persisted = aeordb.files.get('/kikx/agents/agent_1/todo.json');
  assert.deepEqual(persisted.items.map((item) => item.id), [ 'todo_1' ]);
  assert.ok(!('deleted' in persisted));
});

test('AgentTodoStore rejects grandchild creation', async () => {
  let aeordb = createClient();
  let ids = [ 'todo_1', 'todo_2', 'todo_3' ];
  let store = new AgentTodoStore({
    aeordb,
    idGenerator: () => ids.shift(),
  });

  await store.addItem('agent_1', { title: 'Parent' });
  await store.addItem('agent_1', { parentID: 'todo_1', title: 'Child' });

  await assert.rejects(
    () => store.addItem('agent_1', { parentID: 'todo_2', title: 'Grandchild' }),
    /Todo item not found: todo_2/,
  );
});

function createClient() {
  return {
    files: new Map(),
    async getFile(path) {
      if (!this.files.has(path)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return this.files.get(path);
    },
    async putFile(path, body) {
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
  };
}
