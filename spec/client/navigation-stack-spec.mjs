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
  pushThread,
  scopeNounForDepth,
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

// `pushGrid` is gone with the child-session view it addressed: pushing a
// "collapsed" level has no meaning once every session window shows its thread.
test('pushThread adds levels, each an expanded session entry', () => {
  let stack = createNavigationStack();
  stack = pushThread(stack, 'a');
  stack = pushThread(stack, 'b');

  assert.deepEqual(stack, [
    { sessionID: null, collapsed: true },
    { sessionID: 'a', collapsed: false },
    { sessionID: 'b', collapsed: false },
  ]);
  assert.equal(currentSessionID(stack), 'b');
  assert.equal(currentEntry(stack).collapsed, false);
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

test('stackToURL encodes entered sessions and preserves other params', () => {
  let stack = pushThread(pushThread(createNavigationStack(), 'a'), 'b');

  assert.equal(stackToURL(stack, { pathname: '/', search: '' }), '/?session=a&session=b');
  // `collapsed` is never emitted any more; it is a legacy input only.
  assert.doesNotMatch(stackToURL(stack, { pathname: '/' }), /collapsed/);
  // Preserves unrelated params like the magic-link code.
  assert.equal(
    stackToURL(stack, { pathname: '/', search: '?code=abc' }),
    '/?code=abc&session=a&session=b',
  );
  // Root has no session params.
  assert.equal(stackToURL(createNavigationStack(), { pathname: '/' }), '/');
});

test('stackFromSearchParams rebuilds the stack and tolerates legacy view flags', () => {
  // `collapsed=1` was written by the child-grid view. The view is gone, so the
  // flag must be parsed and discarded: a bookmark or a reload from a tab that was
  // trapped in the grid has to land in the thread, not in a state that no longer
  // exists. Silently dropping it keeps the round-trip quiet instead of erroring.
  let parsed = stackFromSearchParams('?code=abc&session=a&session=b&collapsed=1');
  assert.deepEqual(parsed.stack, [
    { sessionID: null, collapsed: true },
    { sessionID: 'a', collapsed: false },
    { sessionID: 'b', collapsed: false },
  ]);
  assert.equal(parsed.viewThread, false);

  assert.deepEqual(stackFromSearchParams('').stack, [ { sessionID: null, collapsed: true } ]);

  // Legacy ?view=thread with no session asks the caller to open the first.
  assert.equal(stackFromSearchParams('?view=thread').viewThread, true);
  // Legacy ?view=sub-sessions is ignored the same way `collapsed=1` is.
  let legacy = stackFromSearchParams('?session=a&view=sub-sessions');
  assert.equal(legacy.stack.at(-1).collapsed, false);
  assert.equal(legacy.view, null, 'it is not an addressable view name');
});

test('stack URL round-trips', () => {
  let stack = pushThread(pushThread(createNavigationStack(), 'a'), 'b');
  let url = stackToURL(stack, { pathname: '/' });
  let search = url.slice(url.indexOf('?'));
  assert.deepEqual(stackFromSearchParams(search).stack, stack);
});

// --- Non-session view entries (plan §6 inbox) -------------------------------
// `navigation-stack-spec.mjs` predates the view entries, so the stack's view
// behaviour was never covered. These tests pin that contract.
//
// The Activities view was removed at the owner's request (2026-10-28) and its name
// dropped from VIEW_NAMES; the Inbox is now the only member. The *mechanism* is still
// general, so it is still tested — just through Inbox, and with 'activities' asserted
// as a rejected name so its removal cannot silently regress into acceptance.

test('VIEW_NAMES lists every addressable non-session view', async () => {
  const { VIEW_NAMES } = await import('../../src/client/state/navigation-stack.mjs');
  assert.deepEqual(VIEW_NAMES, [ 'inbox', 'agents', 'teams' ]);
});

test('a removed view name is refused, not accepted as a dangling entry', async () => {
  const { createNavigationStack, pushView } =
    await import('../../src/client/state/navigation-stack.mjs');

  // Keeping 'activities' in VIEW_NAMES would let pushView build an entry that no
  // builder can render — a blank work area. Rejection is the correct behaviour.
  assert.throws(() => pushView(createNavigationStack(), 'activities'), /unknown view/);
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

test('pushing a view over a session keeps the session underneath so Back reaches it', async () => {
  const {
    createNavigationStack,
    pushInbox,
    pushView,
    pushThread,
    currentViewName,
    stackDepth,
  } = await import('../../src/client/state/navigation-stack.mjs');

  let stack = pushThread(createNavigationStack(), 'session-1');
  let inbox = pushInbox(stack);
  assert.equal(currentViewName(inbox), 'inbox');
  assert.equal(stackDepth(inbox), stackDepth(stack) + 1, 'the view adds one entry');

  // The session entry survives underneath, so Back still reaches it.
  assert.equal(inbox.at(-2).sessionID, 'session-1');

  // Re-pushing the same view is idempotent: no second copy, so Back never appears
  // to do nothing. Compared structurally — `pushView` returns a fresh array, so `===`
  // would fail even when the stack is unchanged.
  assert.deepEqual(pushView(inbox, 'inbox'), inbox);
});

test('a view entry reports no session for the grid and the deep link', async () => {
  const {
    createNavigationStack,
    pushInbox,
    gridParentSessionID,
    stackToURL,
  } = await import('../../src/client/state/navigation-stack.mjs');

  let stack = pushInbox(createNavigationStack());
  assert.equal(gridParentSessionID(stack), null, 'a view has no parent session');

  // The view is encoded by name, never as a `session=` param.
  let url = stackToURL(stack, { pathname: '/' });
  assert.match(url, /view=inbox/);
  assert.doesNotMatch(url, /session=/);
});

test('stackFromSearchParams restores the activities view', async () => {
  const { stackFromSearchParams } = await import('../../src/client/state/navigation-stack.mjs');

  // 'activities' is no longer addressable: an old bookmark carrying it parses to the
  // plain stack (no view), which is what "degrade to a normal window" means here.
  let parsed = stackFromSearchParams('?view=activities');
  assert.equal(parsed.view, null);
  assert.equal(parsed.stack.at(-1).view, undefined);
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

  // A lone view entry normalizes into the root entry itself: the root has no session
  // and the view rides on it, so `at(-1)` is that one entry.
  let kept = normalizeNavigationStack([ { view: 'inbox' } ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].view, 'inbox');

  // A removed view name is dropped by normalization too, so a stack persisted while
  // Activities existed cannot resurrect the entry.
  let removed = normalizeNavigationStack([ { sessionID: null }, { view: 'activities' } ]);
  assert.equal(removed.at(-1).view, undefined, 'a removed view name is dropped');

  let dropped = normalizeNavigationStack([ { sessionID: null }, { view: 'bogus' } ]);
  assert.equal(dropped.at(-1).view, undefined);
});
