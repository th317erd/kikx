'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNavigationStack,
  currentEntry,
  currentSessionID,
  gridParentSessionID,
  normalizeNavigationStack,
  popStack,
  pushGrid,
  pushThread,
  scopeNounForDepth,
  setCollapsed,
  stackDepth,
} from '../../src/client/state/navigation-stack.mjs';

test('createNavigationStack starts at the root grid', () => {
  assert.deepEqual(createNavigationStack(), [ { sessionID: null, collapsed: true } ]);
});

test('normalizeNavigationStack repairs empty and non-root-first stacks', () => {
  assert.deepEqual(normalizeNavigationStack(null), [ { sessionID: null, collapsed: true } ]);
  assert.deepEqual(normalizeNavigationStack([]), [ { sessionID: null, collapsed: true } ]);
  assert.deepEqual(normalizeNavigationStack([ { sessionID: 'a', collapsed: false } ]), [
    { sessionID: null, collapsed: true },
    { sessionID: 'a', collapsed: false },
  ]);
});

test('pushThread and pushGrid add levels with the right collapsed state', () => {
  let stack = createNavigationStack();
  stack = pushThread(stack, 'a');
  stack = pushThread(stack, 'b');
  stack = pushGrid(stack, 'c');

  assert.deepEqual(stack, [
    { sessionID: null, collapsed: true },
    { sessionID: 'a', collapsed: false },
    { sessionID: 'b', collapsed: false },
    { sessionID: 'c', collapsed: true },
  ]);
  assert.equal(currentSessionID(stack), 'c');
  assert.equal(currentEntry(stack).collapsed, true);
});

test('pushThread ignores blank session IDs', () => {
  let stack = createNavigationStack();
  assert.deepEqual(pushThread(stack, ''), stack);
  assert.deepEqual(pushThread(stack, '   '), stack);
  assert.deepEqual(pushThread(stack, null), stack);
});

test('popStack never removes the root', () => {
  let stack = pushThread(createNavigationStack(), 'a');
  let popped = popStack(stack);
  assert.equal(popped.length, 1);
  assert.deepEqual(popStack(popped), [ { sessionID: null, collapsed: true } ]);
});

test('setCollapsed toggles only the top entry', () => {
  let stack = pushThread(pushThread(createNavigationStack(), 'a'), 'b');
  let collapsed = setCollapsed(stack, true);
  assert.equal(collapsed.at(-1).collapsed, true);
  assert.equal(collapsed.at(-2).collapsed, false);
  assert.equal(collapsed.length, 3);
});

test('gridParentSessionID returns the current session (children owner)', () => {
  assert.equal(gridParentSessionID(createNavigationStack()), null);
  assert.equal(gridParentSessionID(pushThread(createNavigationStack(), 'a')), 'a');
});

test('stackDepth and scopeNounForDepth map depth to user-facing scope', () => {
  assert.equal(stackDepth(createNavigationStack()), 1);
  assert.equal(stackDepth(pushThread(createNavigationStack(), 'a')), 2);

  assert.equal(scopeNounForDepth(1), 'Project');
  assert.equal(scopeNounForDepth(2), 'Session');
  assert.equal(scopeNounForDepth(3), 'Sub-Session');
  assert.equal(scopeNounForDepth(5), 'Sub-Session');
});
