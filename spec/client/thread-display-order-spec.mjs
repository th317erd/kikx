'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { promoteTailResponse } from '../../src/client/components/thread-display-order.mjs';

function item(id, type, commitOrder) {
  return {
    key: id,
    frame: {
      id,
      type,
      commitOrder,
      content: { status: type === 'AgentMessage' ? 'complete' : 'success' },
    },
  };
}

test('a completed response created before its tools is moved to the last page', () => {
  let pages = [
    { loaded: true, items: [ item('response', 'AgentMessage', 16582) ] },
    { loaded: true, items: [ item('tool-a', 'ShellToolFrame', 16570) ] },
    { loaded: true, items: [ item('tool-b', 'ShellToolFrame', 16579) ] },
  ];

  let updates = promoteTailResponse(pages);
  assert.deepEqual(updates.map((update) => update.pageIndex), [ 0, 2 ]);
  assert.deepEqual(updates[0].items, []);
  assert.deepEqual(updates[1].items.map((entry) => entry.frame.id), [ 'tool-b', 'response' ]);
});

test('a response already on the latest page is not moved', () => {
  let pages = [
    { loaded: true, items: [ item('tool', 'ShellToolFrame', 90) ] },
    { loaded: true, items: [ item('response', 'AgentMessage', 100) ] },
  ];

  assert.deepEqual(promoteTailResponse(pages), []);
});

test('an older completed response is not moved over a newer latest page', () => {
  let pages = [
    { loaded: true, items: [ item('old-response', 'AgentMessage', 50) ] },
    { loaded: true, items: [ item('new-tool', 'ShellToolFrame', 100) ] },
  ];

  assert.deepEqual(promoteTailResponse(pages), []);
});

test('unloaded or single pages are left alone', () => {
  assert.deepEqual(promoteTailResponse([ { loaded: true, items: [] } ]), []);
  assert.deepEqual(promoteTailResponse([
    { loaded: true, items: [ item('response', 'AgentMessage', 100) ] },
    { loaded: false, items: [] },
  ]), []);
});
