'use strict';

// Integration coverage for the todo tool card: the real TodoToolUse class fed
// real frames must name items and must NEVER surface a raw UUID.
//
// todo-summary-spec.mjs covers the pure helpers; this covers the wiring in
// tool-use-base.mjs (frame -> content -> previewOutput -> parseToolOutput ->
// summary), which is where the delete-result case previously lost the item's
// name (the deleted todo is gone from the returned state).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
globalThis.document = document;

const { TodoToolUse } = await import('../../src/client/components/tool-renderers/tool-use-base.mjs');

const UUID = '3f2a9c11-8a4e-4b7c-9d2e-5b1f0c6a7d8e';
const TODO_STATE = {
  items: [
    { id: UUID, title: 'Capture live request', status: 'pending' },
    { id: 'other', title: 'Something else', status: 'pending' },
  ],
  focus: null,
};

function toolFrame({ type, content }) {
  return { id: `${type}-1`, type, content };
}

function elementFor(frame) {
  let element = new TodoToolUse();
  element.updateFrame(frame, {});
  return element;
}

function callFrame(toolName, input, state = TODO_STATE) {
  return toolFrame({
    type: 'ToolCall',
    content: { toolName, phase: 'call', input, format: 'json', preview: JSON.stringify(state) },
  });
}

function resultFrame(toolName, state, input = {}) {
  return toolFrame({
    type: 'ToolResult',
    content: { toolName, phase: 'result', status: 'success', input, format: 'json', preview: JSON.stringify(state) },
  });
}

test('TodoToolUse names the item a todo-delete call targets', () => {
  let element = elementFor(callFrame('todo-delete', { id: UUID }));
  let summary = element.callSummary();

  assert.equal(summary, 'Deleting todo: Capture live request');
  assert.ok(!summary.includes(UUID), 'the raw id must never be shown');
});

test('TodoToolUse names a todo-update target instead of its id', () => {
  let element = elementFor(callFrame('todo-update', { id: UUID, status: 'in_progress' }));
  assert.equal(element.callSummary(), 'Updating todo: Capture live request');
});

test('TodoToolUse names the deleted item from the result, which no longer lists it', () => {
  let element = elementFor(resultFrame('todo-delete', {
    items: [ TODO_STATE.items[1] ],
    focus: null,
    deleted: { id: UUID, title: 'Capture live request' },
  }));

  let summary = element.resultSummary();
  assert.equal(summary, 'Deleted todo: Capture live request');
  assert.ok(!summary.includes(UUID));
});

test('TodoToolUse degrades to a generic phrase, never an id, for an unknown target', () => {
  let element = elementFor(callFrame('todo-complete', { id: 'does-not-exist' }));
  let summary = element.callSummary();

  assert.equal(summary, 'Completing todo...');
  assert.ok(!summary.includes('does-not-exist'));
});

test('TodoToolUse reads a non-json preview without crashing', () => {
  let element = elementFor(toolFrame({
    type: 'ToolResult',
    content: { toolName: 'todo-get', phase: 'result', status: 'success', format: 'text', preview: 'not json at all' },
  }));

  assert.equal(element.resultSummary(), 'Todo list completed.');
});

test('TodoToolUse result summary reports a failure', () => {
  let element = elementFor(toolFrame({
    type: 'ToolResult',
    content: { toolName: 'todo-clear', phase: 'result', status: 'error', format: 'json', preview: '{}' },
  }));

  assert.equal(element.resultSummary(), 'Todo list failed.');
});
