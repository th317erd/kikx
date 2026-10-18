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
  stackFromSearchParams,
  stackToURL,
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

test('stackToURL encodes entered sessions and collapsed state, preserving other params', () => {
  let stack = pushThread(pushThread(createNavigationStack(), 'a'), 'b');
  let collapsed = setCollapsed(stack, true);

  assert.equal(stackToURL(stack, { pathname: '/', search: '' }), '/?session=a&session=b');
  assert.equal(
    stackToURL(collapsed, { pathname: '/', search: '' }),
    '/?session=a&session=b&collapsed=1',
  );
  // Preserves unrelated params like the magic-link code.
  assert.equal(
    stackToURL(stack, { pathname: '/', search: '?code=abc' }),
    '/?code=abc&session=a&session=b',
  );
  // Root has no session params.
  assert.equal(stackToURL(createNavigationStack(), { pathname: '/' }), '/');
});

test('stackFromSearchParams rebuilds the stack and legacy view flags', () => {
  let parsed = stackFromSearchParams('?code=abc&session=a&session=b&collapsed=1');
  assert.deepEqual(parsed.stack, [
    { sessionID: null, collapsed: true },
    { sessionID: 'a', collapsed: false },
    { sessionID: 'b', collapsed: true },
  ]);
  assert.equal(parsed.viewThread, false);

  assert.deepEqual(stackFromSearchParams('').stack, [ { sessionID: null, collapsed: true } ]);

  // Legacy ?view=thread with no session asks the caller to open the first.
  assert.equal(stackFromSearchParams('?view=thread').viewThread, true);
  // Legacy ?view=sub-sessions maps to collapsed.
  let legacy = stackFromSearchParams('?session=a&view=sub-sessions');
  assert.equal(legacy.stack.at(-1).collapsed, true);
});

test('stack URL round-trips', () => {
  let stack = setCollapsed(pushThread(pushThread(createNavigationStack(), 'a'), 'b'), true);
  let url = stackToURL(stack, { pathname: '/' });
  let search = url.slice(url.indexOf('?'));
  assert.deepEqual(stackFromSearchParams(search).stack, stack);
});

// --- Non-session view entries (plan §6 inbox, §6.4 activities) ---------------
// `navigation-stack-spec.mjs` predates the view entries, so the stack's view
// behaviour was never covered. These tests pin the contract that made the
// Activities view possible without disturbing the Inbox.

test('VIEW_NAMES lists every addressable non-session view', async () => {
  const { VIEW_NAMES } = await import('../../src/client/state/navigation-stack.mjs');
  assert.deepEqual(VIEW_NAMES, [ 'inbox', 'activities' ]);
});

test('pushView is idempotent for the same view and refuses unknown names', async () => {
  const { createNavigationStack, pushView, currentViewName } =
    await import('../../src/client/state/navigation-stack.mjs');

  let root = createNavigationStack();
  let inbox = pushView(root, 'inbox');
  assert.equal(currentViewName(inbox), 'inbox');

  // Entering the same view twice must not stack two copies, or Back looks broken.
  assert.deepEqual(pushView(inbox, 'inbox'), inbox);

  // A typo'd view name is a programming error, not a silent no-op.
  assert.throws(() => pushView(root, 'nonsense'), TypeError);
});

test('switching views replaces the view entry instead of burying the session', async () => {
  const {
    createNavigationStack,
    pushInbox,
    pushActivities,
    pushThread,
    currentViewName,
    stackDepth,
  } = await import('../../src/client/state/navigation-stack.mjs');

  let stack = pushThread(createNavigationStack(), 'session-1');
  let inbox = pushInbox(stack);
  assert.equal(currentViewName(inbox), 'inbox');
  let depthWithInbox = stackDepth(inbox);

  // Inbox -> Activities must swap the top entry, not add a second one: otherwise
  // Back from Activities lands on Inbox rather than the session underneath.
  let activities = pushActivities(inbox);
  assert.equal(currentViewName(activities), 'activities');
  assert.equal(stackDepth(activities), depthWithInbox, 'no extra stack entry');

  // The session entry survives underneath, so Back still reaches it.
  assert.equal(activities.at(-2).sessionID, 'session-1');
});

test('a view entry reports no session for the grid and the deep link', async () => {
  const {
    createNavigationStack,
    pushActivities,
    gridParentSessionID,
    stackToURL,
  } = await import('../../src/client/state/navigation-stack.mjs');

  let stack = pushActivities(createNavigationStack());
  assert.equal(gridParentSessionID(stack), null, 'a view has no parent session');

  // The view is encoded by name, never as a `session=` param.
  let url = stackToURL(stack, { pathname: '/' });
  assert.match(url, /view=activities/);
  assert.doesNotMatch(url, /session=/);
});

test('stackFromSearchParams restores the activities view', async () => {
  const { stackFromSearchParams } = await import('../../src/client/state/navigation-stack.mjs');

  let parsed = stackFromSearchParams('?view=activities');
  assert.equal(parsed.view, 'activities');
  assert.equal(parsed.stack.at(-1).view, 'activities');
  // `viewInbox` stays meaningful for existing §6.6 callers.
  assert.equal(parsed.viewInbox, false);

  let inbox = stackFromSearchParams('?view=inbox');
  assert.equal(inbox.viewInbox, true);
  assert.equal(inbox.view, 'inbox');
});

test('an unknown view param falls back to the session stack, not a broken entry', async () => {
  const { stackFromSearchParams } = await import('../../src/client/state/navigation-stack.mjs');

  let parsed = stackFromSearchParams('?view=bogus&session=a');
  assert.equal(parsed.view, null);
  assert.deepEqual(parsed.stack, [
    { sessionID: null, collapsed: true },
    { sessionID: 'a', collapsed: false },
  ]);
});

test('normalizeNavigationStack preserves a known view and drops an unknown one', async () => {
  const { normalizeNavigationStack } = await import('../../src/client/state/navigation-stack.mjs');

  let kept = normalizeNavigationStack([ { view: 'activities' } ]);
  assert.equal(kept.at(-1).view, 'activities');

  let dropped = normalizeNavigationStack([ { sessionID: null }, { view: 'bogus' } ]);
  assert.equal(dropped.at(-1).view, undefined);
});
