'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FocusTodoFramePlugin,
  setup,
} from '../../../plugins/todo-focus-index/index.mjs';

function fakeRegistry() {
  let state = { indexes: [], selectors: [], tools: new Map() };
  return {
    state,
    registerFrameIndex(name, definition) { state.indexes.push({ name, ...definition }); },
    registerSelector(selector, PluginClass, pluginID) { state.selectors.push({ selector, PluginClass, pluginID }); },
    registerTool(name, ToolClass) { state.tools.set(name, ToolClass); return ToolClass; },
    getClass(name) {
      if (name !== 'PluginInterface')
        return null;
      return class PluginInterface {
        constructor(context = {}) { this.context = context; }
        async execute(params = {}) { return await this._execute(params); }
      };
    },
  };
}

test('the plugin registers the focus index, selector, and query tool', () => {
  let registry = fakeRegistry();
  setup((callback) => callback({ registry }));

  assert.deepEqual(registry.state.indexes, [ { name: 'focus_todo_id', type: 'string' } ]);
  assert.equal(registry.state.selectors.some((entry) => entry.selector === '*' && entry.PluginClass === FocusTodoFramePlugin), true);
  assert.equal(registry.state.tools.has('todo-frames'), true);
});

test('an agent frame is stamped with its agent focused todo item', async () => {
  let merged = null;
  let context = {
    newFrame: { id: 'frame_1', type: 'ShellToolFrame', authorType: 'agent', authorID: 'agent_1', content: {} },
    engine: {
      merge(frames) { merged = frames[0]; return [ merged ]; },
      get() { return null; },
    },
    session: { id: 'session_1', coordinatorAgentID: 'agent_1' },
    services: {
      agentTodoStore: {
        async getTodoState(agentID) {
          assert.equal(agentID, 'agent_1');
          return { focus: { itemID: 'parent_1', childID: 'todo_1' } };
        },
      },
    },
  };
  let nextContext = null;
  await new FocusTodoFramePlugin(context).process(async (next) => { nextContext = next; });
  assert.equal(merged.focus_todo_id, 'todo_1');
  assert.equal(nextContext.newFrame.focus_todo_id, 'todo_1');
});

test('an unfocused agent does not receive a fabricated todo id', async () => {
  let calls = 0;
  let context = {
    newFrame: { id: 'frame_1', type: 'ShellToolFrame', authorType: 'agent', authorID: 'agent_1' },
    engine: { merge() { calls += 1; return []; }, get() { return null; } },
    session: { id: 'session_1' },
    services: {
      agentTodoStore: { async getTodoState() { return { focus: null }; } },
    },
  };
  let nextContext = null;
  await new FocusTodoFramePlugin(context).process(async (next) => { nextContext = next; });
  assert.equal(calls, 0);
  assert.equal(nextContext.newFrame.focus_todo_id, undefined);
});

test('todo-frames queries the indexed focus field for the current session', async () => {
  let registry = fakeRegistry();
  setup((callback) => callback({ registry }));
  let Tool = registry.state.tools.get('todo-frames');
  let query = null;
  let result = await new Tool({
    session: { id: 'session_1' },
    services: {
      aeordb: {
        async searchFiles(input) {
          query = input;
          return { results: [ { path: '/kikx/sessions/session_1/interactions/a/frames/1-ShellToolFrame-x.json' } ] };
        },
      },
    },
  }).execute({ todo_id: 'todo_1', limit: 10, offset: 0 });

  assert.equal(query.where.field, 'focus_todo_id');
  assert.equal(query.where.value, 'todo_1');
  assert.equal(query.path, '/kikx/sessions/session_1/interactions');
  assert.equal(result.todo_id, 'todo_1');
  assert.equal(result.count, 1);
});
