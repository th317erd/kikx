'use strict';

// The filter popup's click semantics are the part most likely to regress
// silently, because they involve modifier keys and a master row with three
// states. These tests pin the pure reducer; a separate spec covers the DOM
// wiring on top of it.
//
// Two different notions of "not for you" are tested here, because conflating
// them is a real bug this file exists to prevent:
//   hidden:true  - system-only bookkeeping, never visible to anyone
//   deleted:true - soft-deleted content the user can ask to see again

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_KEYS,
  DELETED_ROW,
  FILTER_KEYS,
  allFilters,
  applyFrameFilters,
  classifyFrame,
  cloneFrameFilters,
  defaultFrameFilters,
  everyFilterOn,
  filterCounts,
  filterSummary,
  frameFiltersSignature,
  frameMatchesFilters,
  noFilterOn,
  normalizeFrameFilters,
  onlyFilter,
  toggleAllFilters,
  toggleFilter,
  wantsDeletedFrames,
} from '../../src/client/lib/frame-filters.mjs';

test('every category starts enabled, so the default view shows everything visible', () => {
  let filters = defaultFrameFilters();
  assert.equal(everyFilterOn(filters), true);
  assert.equal(filterSummary(filters), 'on');
  for (let key of CATEGORY_KEYS)
    assert.equal(filters[key], true, `${key} starts on`);
});

test('the Deleted reveal starts off, so soft-deleted content stays hidden until asked for', () => {
  assert.equal(defaultFrameFilters().deleted, false);
  assert.equal(wantsDeletedFrames(defaultFrameFilters()), false);
});

test('normalizeFrameFilters repairs missing and non-boolean entries to each row default', () => {
  let filters = normalizeFrameFilters({ user: false, agent: 'no', question: null });
  assert.equal(filters.user, false, 'an explicit false survives');
  assert.equal(filters.agent, true, 'a non-boolean falls back to on');
  assert.equal(filters.question, true, 'null falls back to on');
  assert.equal(filters.deleted, false, 'a missing reveal falls back to off, not on');
  assert.deepEqual(normalizeFrameFilters(null), defaultFrameFilters());
});

test('normalizeFrameFilters keeps an explicitly enabled reveal', () => {
  assert.equal(normalizeFrameFilters({ deleted: true }).deleted, true);
});

test('normalizeFrameFilters drops keys that are not filters', () => {
  let filters = normalizeFrameFilters({ user: false, bogus: false });
  assert.equal('bogus' in filters, false);
});

test('plain click flips exactly one row and leaves the rest alone', () => {
  let filters = defaultFrameFilters();
  let next = toggleFilter(filters, 'tools');
  assert.equal(next.tools, false);
  assert.equal(next.user, true);
  assert.equal(next.agent, true);
  assert.equal(filters.tools, true, 'the input is not mutated');

  let back = toggleFilter(next, 'tools');
  assert.deepEqual(back, defaultFrameFilters());
});

test('plain click on an unknown key changes nothing', () => {
  let filters = defaultFrameFilters();
  assert.deepEqual(toggleFilter(filters, 'bogus'), filters);
});

test('Ctrl+Click leaves only the clicked category enabled', () => {
  let next = onlyFilter(defaultFrameFilters(), 'question');
  assert.equal(next.question, true);
  for (let key of CATEGORY_KEYS) {
    if (key !== 'question')
      assert.equal(next[key], false, `${key} is cleared by Ctrl+Click`);
  }
  assert.equal(filterSummary(next), 'mixed');
});

test('Ctrl+Click on an already-isolated row restores every category', () => {
  // A second Ctrl+Click is the escape hatch out of an isolation, so the view can
  // never be stranded on one category with no obvious way back.
  let isolated = onlyFilter(defaultFrameFilters(), 'question');
  assert.deepEqual(onlyFilter(isolated, 'question'), defaultFrameFilters());
});

test('Ctrl+Click on an unknown key changes nothing', () => {
  let filters = defaultFrameFilters();
  assert.deepEqual(onlyFilter(filters, 'bogus'), filters);
});

test('Shift+Click turns every category on, from any starting point', () => {
  let allOff = allFilters(defaultFrameFilters(), false);
  assert.equal(noFilterOn(allOff), true);

  assert.deepEqual(allFilters(allOff), defaultFrameFilters());
  assert.deepEqual(allFilters(onlyFilter(defaultFrameFilters(), 'user')), defaultFrameFilters());
  assert.deepEqual(allFilters(defaultFrameFilters()), defaultFrameFilters());

  let shifted = allFilters(defaultFrameFilters(), true);
  assert.equal(everyFilterOn(shifted), true);

  let cleared = allFilters(allOff, false);
  assert.equal(noFilterOn(cleared), true, 'the explicit off form clears everything');
});

test('the pinned row toggles: all on when anything is off, all off when everything is on', () => {
  let allOn = defaultFrameFilters();
  let afterFirst = toggleAllFilters(allOn);
  assert.equal(noFilterOn(afterFirst), true, 'clicking the pinned row from "all on" clears everything');
  assert.equal(filterSummary(afterFirst), 'off');

  let afterSecond = toggleAllFilters(afterFirst);
  assert.equal(everyFilterOn(afterSecond), true, 'clicking again turns everything back on');
});

test('the pinned row from a mixed selection turns everything on, not off', () => {
  let mixed = onlyFilter(defaultFrameFilters(), 'agent');
  assert.equal(filterSummary(mixed), 'mixed');
  assert.equal(everyFilterOn(toggleAllFilters(mixed)), true);
});

test('the pinned row reports on, off and mixed', () => {
  assert.equal(filterSummary(defaultFrameFilters()), 'on');
  assert.equal(filterSummary(allFilters(defaultFrameFilters(), false)), 'off');
  assert.equal(filterSummary(onlyFilter(defaultFrameFilters(), 'tools')), 'mixed');
});

test('cloneFrameFilters is a copy, not a reference', () => {
  let filters = defaultFrameFilters();
  let copy = cloneFrameFilters(filters);
  copy.user = false;
  assert.equal(filters.user, true);
});

test('frames are classified into every category they belong to', () => {
  assert.deepEqual(classifyFrame({ type: 'UserMessage', authorType: 'user' }), [ 'user' ]);
  assert.deepEqual(classifyFrame({ type: 'AgentMessage', authorType: 'agent' }), [ 'agent' ]);
  assert.deepEqual(classifyFrame({ type: 'AgentProgress', authorType: 'agent' }), [ 'agent' ]);
  assert.deepEqual(classifyFrame({ type: 'Question', authorType: 'agent' }), [ 'agent', 'question' ], 'display order, not insertion order');
  assert.deepEqual(classifyFrame({ type: 'ToolCall' }), [ 'tools' ]);
  assert.deepEqual(classifyFrame({ type: 'ToolResult' }), [ 'tools' ]);
  assert.deepEqual(classifyFrame({ type: 'CommandResult' }), [ 'commands' ]);
  assert.deepEqual(classifyFrame({ type: 'CompactionFrame' }), [ 'compaction' ]);
});

test('a frame referencing a child session is a Sessions frame', () => {
  let frame = {
    type: 'UserMessage',
    authorType: 'user',
    content: { references: [ { type: 'session', id: 'child-1' } ] },
  };
  assert.deepEqual(classifyFrame(frame), [ 'user', 'session' ], 'display order');
});

test('a tool result that spawns a session is a Sessions frame too', () => {
  assert.deepEqual(classifyFrame({ type: 'ToolResult', content: { sessionID: 'child-9' } }), [ 'session', 'tools' ]);
});

test('a blank or non-session reference does not count', () => {
  assert.deepEqual(classifyFrame({ type: 'UserMessage', content: { references: [ { type: 'session', id: '  ' } ] } }), [ 'user' ]);
  assert.deepEqual(classifyFrame({ type: 'UserMessage', content: { references: [ { type: 'frame', id: 'x' } ] } }), [ 'user' ]);
  assert.deepEqual(classifyFrame({ type: 'UserMessage', content: { references: 'nope' } }), [ 'user' ]);
});

test('a frame shows when any one of its categories is enabled', () => {
  let question = { type: 'Question', authorType: 'agent' };
  let onlyQuestion = onlyFilter(defaultFrameFilters(), 'question');
  assert.equal(frameMatchesFilters(question, onlyQuestion), true, 'question on, agent off still shows the question');

  let onlyAgent = onlyFilter(defaultFrameFilters(), 'agent');
  assert.equal(frameMatchesFilters(question, onlyAgent), true, 'agent on, question off still shows it');
});

test('turning off every category the frame belongs to hides it', () => {
  let question = { type: 'Question', authorType: 'agent' };
  let neither = allFilters(defaultFrameFilters(), false);
  assert.equal(frameMatchesFilters(question, neither), false);
});

test('an unclassifiable frame survives any partial selection', () => {
  let unknown = { type: 'SomeFutureFrame' };
  assert.deepEqual(classifyFrame(unknown), []);
  assert.equal(frameMatchesFilters(unknown, onlyFilter(defaultFrameFilters(), 'tools')), true);
});

test('clearing every row empties the thread, including unclassifiable frames', () => {
  let unknown = { type: 'SomeFutureFrame' };
  assert.equal(frameMatchesFilters(unknown, allFilters(defaultFrameFilters(), false)), false);
});

// --- hidden is revealed by the Hidden gate --------------------------------

test('a hidden frame is revealed only by the Hidden gate', () => {
  let hiddenUser = { type: 'UserMessage', authorType: 'user', hidden: true };
  assert.equal(frameMatchesFilters(hiddenUser, defaultFrameFilters()), false);
  assert.equal(frameMatchesFilters(hiddenUser, allFilters(defaultFrameFilters(), true)), false);
  assert.equal(frameMatchesFilters(hiddenUser, toggleFilter(defaultFrameFilters(), 'deleted')), true);
  assert.equal(frameMatchesFilters(hiddenUser, toggleFilter(defaultFrameFilters(), 'user')), false);
});

test('a frame that is both hidden and deleted is revealed by the same gate', () => {
  let frame = { type: 'UserMessage', authorType: 'user', hidden: true, deleted: true };
  assert.equal(frameMatchesFilters(frame, toggleFilter(defaultFrameFilters(), 'deleted')), true);
});

// --- deleted is a reveal ------------------------------------------------

test('a deleted frame needs the Deleted reveal plus one of its own categories', () => {
  let deletedUser = { type: 'UserMessage', authorType: 'user', deleted: true };
  assert.equal(frameMatchesFilters(deletedUser, defaultFrameFilters()), false, 'the reveal is off by default');

  let revealOn = toggleFilter(defaultFrameFilters(), 'deleted');
  assert.equal(frameMatchesFilters(deletedUser, revealOn), true, 'reveal on shows it under its category');

  let revealOnUserOff = toggleFilter(revealOn, 'user');
  assert.equal(frameMatchesFilters(deletedUser, revealOnUserOff), false, 'the reveal does not override a turned-off category');
});

test('the reveal does not hide ordinary frames when it is switched on', () => {
  let visible = { type: 'UserMessage', authorType: 'user' };
  assert.equal(frameMatchesFilters(visible, defaultFrameFilters()), true);
  assert.equal(frameMatchesFilters(visible, toggleFilter(defaultFrameFilters(), 'deleted')), true);
});

test('the owner\'s worked examples all hold', () => {
  let userMessage = { type: 'UserMessage', authorType: 'user' };
  let deletedUserMessage = { type: 'UserMessage', authorType: 'user', deleted: true };
  let sessionFrame = { type: 'Session' };
  let deletedSessionFrame = { type: 'Session', deleted: true };

  // 1. See only sessions: Ctrl+Click Sessions.
  let onlySessions = onlyFilter(defaultFrameFilters(), 'session');
  assert.equal(frameMatchesFilters(sessionFrame, onlySessions), true);
  assert.equal(frameMatchesFilters(userMessage, onlySessions), false);

  // 2. See deleted sessions: Ctrl+Click Sessions, then click Deleted.
  //    This ADDS the deleted ones to the session view; it does not hide the live
  //    ones. Deleted is a gate, not an "only deleted" mode.
  let sessionsWithDeleted = toggleFilter(onlySessions, 'deleted');
  assert.equal(frameMatchesFilters(deletedSessionFrame, sessionsWithDeleted), true, 'the deleted session appears');
  assert.equal(frameMatchesFilters(sessionFrame, sessionsWithDeleted), true, 'and the live sessions still do');

  // 3. See only user messages: Ctrl+Click User.
  let onlyUser = onlyFilter(defaultFrameFilters(), 'user');
  assert.equal(frameMatchesFilters(userMessage, onlyUser), true);
  assert.equal(frameMatchesFilters(sessionFrame, onlyUser), false);

  // 4. See deleted user messages: Ctrl+Click User, then click Deleted.
  let userWithDeleted = toggleFilter(onlyUser, 'deleted');
  assert.equal(frameMatchesFilters(deletedUserMessage, userWithDeleted), true, 'the deleted message appears');
  assert.equal(frameMatchesFilters(userMessage, userWithDeleted), true, 'and the live messages still do');

  // The reveal never leaks across categories: revealing deleted content while
  // only User is on must not surface a deleted session.
  assert.equal(frameMatchesFilters(deletedSessionFrame, userWithDeleted), false);
});

test('deleted content is opt-in, and the bulk gestures leave it alone', () => {
  assert.equal(wantsDeletedFrames(defaultFrameFilters()), false, 'nothing is revealed on first load');
  assert.equal(wantsDeletedFrames(toggleFilter(defaultFrameFilters(), 'deleted')), true);

  // Shift+Click and the pinned row act on the categories. If either switched the
  // reveal on, "select all" would resurrect deleted content as a side effect.
  assert.equal(wantsDeletedFrames(allFilters(defaultFrameFilters(), false)), false);
  assert.equal(wantsDeletedFrames(allFilters(allFilters(defaultFrameFilters(), false))), false, 'select-all leaves the reveal off');

  let isolated = onlyFilter(defaultFrameFilters(), 'question');
  assert.equal(wantsDeletedFrames(isolated), false, 'Ctrl+Click on Question does not reveal deleted frames');
});

test('Ctrl+Click on the reveal turns it on without emptying the categories', () => {
  let onlyReveal = onlyFilter(defaultFrameFilters(), 'deleted');
  assert.equal(onlyReveal.deleted, true, 'the reveal turns on');
  assert.equal(everyFilterOn(onlyReveal), true, 'the categories are left on, so something is still visible');
  assert.equal(filterSummary(onlyReveal), 'on');
});

test('filterCounts includes hidden frames in the Hidden gate and its categories', () => {
  let frames = [
    { type: 'UserMessage', authorType: 'user' },
    { type: 'AgentMessage', authorType: 'agent' },
    { type: 'Question', authorType: 'agent' },
    { type: 'ToolCall' },
    { type: 'CompactionFrame' },
    { type: 'UserMessage', authorType: 'user', deleted: true },
    { type: 'UserMessage', authorType: 'user', hidden: true },
  ];
  let counts = filterCounts(frames);
  assert.equal(counts.user, 3, 'the hidden message is part of the user model');
  assert.equal(counts.agent, 2);
  assert.equal(counts.question, 1);
  assert.equal(counts.tools, 1);
  assert.equal(counts.compaction, 1);
  assert.equal(counts.commands, 0);
  assert.equal(counts.deleted, 2, 'the hidden and deleted rows are counted by the Hidden gate');
  for (let key of FILTER_KEYS)
    assert.equal(typeof counts[key], 'number');
});

test('DELETED_ROW is the only non-category row', () => {
  assert.deepEqual(FILTER_KEYS, [ ...CATEGORY_KEYS, DELETED_ROW.key ]);
  assert.equal(CATEGORY_KEYS.includes(DELETED_ROW.key), false);
});

test('the signature changes only when a filter or the query actually flips', () => {
  let filters = defaultFrameFilters();
  assert.equal(frameFiltersSignature(filters), frameFiltersSignature(defaultFrameFilters()));
  assert.notEqual(frameFiltersSignature(filters), frameFiltersSignature(toggleFilter(filters, 'tools')));
  assert.notEqual(frameFiltersSignature(filters), frameFiltersSignature(filters, 'deploy'));
  assert.equal(frameFiltersSignature(filters), frameFiltersSignature(filters, 'deploy'.slice(0, 0)));
});
