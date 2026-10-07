'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractDeletedTodo,
  extractTodoItems,
  findTodoTitle,
  todoCallSummary,
  todoResultSummary,
  todoSubject,
} from '../../src/client/components/tool-renderers/todo-summary.mjs';

// Shapes mirror the real tool-result frames: the call input carries only an id
// for update/complete/delete/focus-set, and the result preview is the JSON todo
// state (agentID + items[] + focus). See the todo tool renderer.
const TODO_STATE = {
  agentID: 'd6c4cbec-f34b-4eb2-8aff-9964d40b329b',
  items: [
    { id: '20c8b1ed-2c99-486a-8fdf-2da6af235f67', title: 'Orient: read AGENTS.md', notes: '', children: [] },
    {
      id: '2e6fa071-79fd-464e-b758-bcb0ffaee290',
      title: 'Verify compaction fix',
      notes: '',
      children: [
        { id: 'child-1', title: 'Capture live request', notes: '', children: [] },
      ],
    },
  ],
  focus: null,
};

test('extractTodoItems parses an object, a JSON string, and a bare list', () => {
  assert.equal(extractTodoItems(TODO_STATE).length, 2);
  assert.equal(extractTodoItems(JSON.stringify(TODO_STATE)).length, 2);
  assert.equal(extractTodoItems([ { id: 'x', title: 'y' } ]).length, 1);
  assert.deepEqual(extractTodoItems('not json {'), []);
  assert.deepEqual(extractTodoItems(null), []);
});

test('findTodoTitle resolves top-level and one-level sub-items by id', () => {
  assert.equal(findTodoTitle(TODO_STATE.items, '2e6fa071-79fd-464e-b758-bcb0ffaee290'), 'Verify compaction fix');
  assert.equal(findTodoTitle(TODO_STATE.items, 'child-1'), 'Capture live request');
  assert.equal(findTodoTitle(TODO_STATE.items, 'unknown'), '');
});

test('todoSubject prefers an explicit input title, then the id lookup, then the deleted item', () => {
  assert.equal(todoSubject({ input: { title: '  Renamed  ' }, items: TODO_STATE.items }), 'Renamed');
  assert.equal(
    todoSubject({ input: { id: '2e6fa071-79fd-464e-b758-bcb0ffaee290' }, items: TODO_STATE.items }),
    'Verify compaction fix',
  );
  assert.equal(todoSubject({ input: { id: 'missing' }, items: TODO_STATE.items }), '');
  // A delete result no longer lists the item, so `deleted` is the last resort.
  assert.equal(
    todoSubject({ input: { id: '20c8b1ed-2c99-486a-8fdf-2da6af235f67' }, items: [], deleted: { id: '20c8b1ed-2c99-486a-8fdf-2da6af235f67', title: 'Orient: read AGENTS.md' } }),
    'Orient: read AGENTS.md',
  );
});

test('extractDeletedTodo reads the removed item from a parsed or serialized result', () => {
  let result = { items: [], focus: null, deleted: { id: 'todo_2', title: 'Delete me' } };
  assert.deepEqual(extractDeletedTodo(result), { id: 'todo_2', title: 'Delete me' });
  assert.deepEqual(extractDeletedTodo(JSON.stringify(result)), { id: 'todo_2', title: 'Delete me' });
  // No deleted item, a bare list, and malformed JSON all yield null.
  assert.equal(extractDeletedTodo({ items: [] }), null);
  assert.equal(extractDeletedTodo([ { id: 'x', title: 'y' } ]), null);
  assert.equal(extractDeletedTodo('not json {'), null);
  assert.equal(extractDeletedTodo(null), null);
});

test('todo-add call summary shows the new title', () => {
  assert.equal(
    todoCallSummary({ toolName: 'todo-add', input: { title: 'Add SSH client' }, items: [] }),
    'Adding todo: Add SSH client',
  );
});

test('todo-update call summary names the item instead of the raw id', () => {
  let summary = todoCallSummary({
    toolName: 'todo-update',
    input: { id: '2e6fa071-79fd-464e-b758-bcb0ffaee290', status: 'complete' },
    items: TODO_STATE.items,
  });
  assert.equal(summary, 'Updating todo: Verify compaction fix');
  assert.ok(!summary.includes('2e6fa071'), 'summary must never contain the raw id');
});

test('todo-complete/delete/focus-set call summaries resolve the title', () => {
  let items = TODO_STATE.items;
  assert.equal(
    todoCallSummary({ toolName: 'todo-complete', input: { id: '2e6fa071-79fd-464e-b758-bcb0ffaee290' }, items }),
    'Completing todo: Verify compaction fix',
  );
  assert.equal(
    todoCallSummary({ toolName: 'todo-delete', input: { id: 'child-1' }, items }),
    'Deleting todo: Capture live request',
  );
  assert.equal(
    todoCallSummary({ toolName: 'todo-focus-set', input: { id: '2e6fa071-79fd-464e-b758-bcb0ffaee290' }, items }),
    'Focusing todo: Verify compaction fix',
  );
});

test('call summary degrades to a generic phrase when the title is unknown (never an id)', () => {
  let summary = todoCallSummary({ toolName: 'todo-update', input: { id: 'unresolved-id' }, items: [] });
  assert.equal(summary, 'Updating todo...');
  assert.ok(!summary.includes('unresolved-id'));
});

test('an update that only sets status reads as completing', () => {
  assert.equal(
    todoCallSummary({ toolName: 'todo-update', input: { id: 'unresolved', completed: true }, items: [] }),
    'Completing todo...',
  );
});

test('list-level tools read as reading/clearing without a subject', () => {
  assert.equal(todoCallSummary({ toolName: 'todo-get' }), 'Reading todo list...');
  assert.equal(todoCallSummary({ toolName: 'todo-clear' }), 'Clearing todo list...');
  assert.equal(todoCallSummary({ toolName: 'todo-focus-clear' }), 'Clearing todo focus...');
});

test('todo-delete result summary names the removed item even though items no longer contains it', () => {
  let items = TODO_STATE.items.filter((item) => item.id !== '2e6fa071-79fd-464e-b758-bcb0ffaee290');
  let summary = todoResultSummary({
    toolName: 'todo-delete',
    status: 'success',
    input: { id: '2e6fa071-79fd-464e-b758-bcb0ffaee290' },
    items,
    deleted: { id: '2e6fa071-79fd-464e-b758-bcb0ffaee290', title: 'Verify compaction fix' },
  });

  assert.equal(summary, 'Deleted todo: Verify compaction fix');
  assert.ok(!summary.includes('2e6fa071'), 'summary must never contain the raw id');
});

test('todo-delete result summary stays generic when the removed title is not resolvable', () => {
  let summary = todoResultSummary({
    toolName: 'todo-delete',
    status: 'success',
    input: { id: 'unresolved-id' },
    items: [],
  });

  assert.equal(summary, 'Deleted todo.');
  assert.ok(!summary.includes('unresolved-id'));
});

test('result summaries name the item and report failure honestly', () => {
  let items = TODO_STATE.items;
  assert.equal(
    todoResultSummary({ toolName: 'todo-add', status: 'success', input: { title: 'Add SSH client' }, items }),
    'Added todo: Add SSH client',
  );
  assert.equal(
    todoResultSummary({ toolName: 'todo-complete', status: 'success', input: { id: '2e6fa071-79fd-464e-b758-bcb0ffaee290' }, items }),
    'Completed todo: Verify compaction fix',
  );
  assert.equal(
    todoResultSummary({ toolName: 'todo-update', status: 'error', input: { id: 'missing' }, items }),
    'Updated todo.',
  );
  assert.equal(todoResultSummary({ toolName: 'todo-get', status: 'success' }), 'Todo list completed.');
  assert.equal(todoResultSummary({ toolName: 'todo-get', status: 'error' }), 'Todo list failed.');
});
