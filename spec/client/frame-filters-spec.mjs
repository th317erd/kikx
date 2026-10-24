'use strict';

// The filter popup's click semantics are the part most likely to regress
// silently, because they involve modifier keys and a master row with three
// states. These tests pin the pure reducer; a separate spec covers the DOM
// wiring on top of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_KEYS,
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
  wantsHiddenFrames,
} from '../../src/client/lib/frame-filters.mjs';

test('every category starts enabled, so the default view shows everything visible', () => {
  let filters = defaultFrameFilters();
  assert.equal(everyFilterOn(filters), true);
  assert.equal(filterSummary(filters), 'on');
  for (let key of CATEGORY_KEYS)
    assert.equal(filters[key], true, `${key} starts on`);
});

test('the Hidden gate starts off, because hidden frames are internal bookkeeping', () => {
  // Composer drafts, frame groups, scheduled question deadlines and undispatched
  // session invites all set hidden:true and have never been rendered in a thread.
  // An all-on default would dump them into every conversation on first load.
  assert.equal(defaultFrameFilters().hidden, false);
  assert.equal(wantsHiddenFrames(defaultFrameFilters()), false);
});

test('normalizeFrameFilters repairs missing and non-boolean entries to each row default', () => {
  let filters = normalizeFrameFilters({ user: false, agent: 'no', question: null });
  assert.equal(filters.user, false, 'an explicit false survives');
  assert.equal(filters.agent, true, 'a non-boolean falls back to on');
  assert.equal(filters.question, true, 'null falls back to on');
  assert.equal(filters.hidden, false, 'a missing gate falls back to off, not on');
  assert.deepEqual(normalizeFrameFilters(null), defaultFrameFilters());
});

test('normalizeFrameFilters keeps an explicitly enabled gate', () => {
  assert.equal(normalizeFrameFilters({ hidden: true }).hidden, true);
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

test('Ctrl+Click leaves only the clicked row enabled', () => {
  let next = onlyFilter(defaultFrameFilters(), 'question');
  assert.equal(next.question, true);
  for (let key of FILTER_KEYS) {
    if (key !== 'question')
      assert.equal(next[key], false, `${key} is cleared by Ctrl+Click`);
  }
  assert.equal(filterSummary(next), 'mixed');
});

test('Ctrl+Click on an already-isolated row keeps it isolated, so it is not a toggle', () => {
  let isolated = onlyFilter(defaultFrameFilters(), 'question');
  assert.deepEqual(onlyFilter(isolated, 'question'), isolated);
});

test('Ctrl+Click on an unknown key changes nothing', () => {
  let filters = defaultFrameFilters();
  assert.deepEqual(onlyFilter(filters, 'bogus'), filters);
});

test('Shift+Click turns every row on, from any starting point', () => {
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

test('a frame referencing a child session is a Child Sessions frame', () => {
  let frame = {
    type: 'UserMessage',
    authorType: 'user',
    content: { references: [ { type: 'session', id: 'child-1' } ] },
  };
  assert.deepEqual(classifyFrame(frame), [ 'user', 'child-sessions' ], 'display order');
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

test('a hidden frame needs the Hidden row plus one of its own categories', () => {
  let hiddenUser = { type: 'UserMessage', authorType: 'user', hidden: true };
  assert.equal(frameMatchesFilters(hiddenUser, defaultFrameFilters()), false, 'the gate is off by default');

  let gateOn = toggleFilter(defaultFrameFilters(), 'hidden');
  assert.equal(frameMatchesFilters(hiddenUser, gateOn), true, 'gate on reveals it');

  let gateOnUserOff = toggleFilter(gateOn, 'user');
  assert.equal(frameMatchesFilters(hiddenUser, gateOnUserOff), false, 'the gate does not override a turned-off category');
});

test('the gate does not hide ordinary frames when it is switched on', () => {
  let visible = { type: 'UserMessage', authorType: 'user' };
  assert.equal(frameMatchesFilters(visible, defaultFrameFilters()), true);
  assert.equal(frameMatchesFilters(visible, toggleFilter(defaultFrameFilters(), 'hidden')), true);
});

test('applyFrameFilters keeps the surrounding order and identity', () => {
  let frames = [
    { id: 'a', type: 'UserMessage', authorType: 'user' },
    { id: 'b', type: 'ToolCall' },
    { id: 'c', type: 'AgentMessage', authorType: 'agent' },
  ];
  let noTools = toggleFilter(defaultFrameFilters(), 'tools');
  assert.deepEqual(applyFrameFilters(frames, noTools).map((frame) => frame.id), [ 'a', 'c' ]);
});

test('applyFrameFilters tolerates a non-array', () => {
  assert.deepEqual(applyFrameFilters(null, defaultFrameFilters()), []);
  assert.deepEqual(applyFrameFilters(undefined, defaultFrameFilters()), []);
});

test('hidden frames are opt-in, and the bulk gestures do not switch the reveal on', () => {
  assert.equal(wantsHiddenFrames(defaultFrameFilters()), false, 'nothing is revealed on first load');
  assert.equal(wantsHiddenFrames(toggleFilter(defaultFrameFilters(), 'hidden')), true);

  // Shift+Click and the pinned row act on the categories. If either switched the
  // gate on, "select all" would reveal internal frames as a side effect.
  assert.equal(wantsHiddenFrames(allFilters(defaultFrameFilters(), false)), false);
  assert.equal(wantsHiddenFrames(allFilters(allFilters(defaultFrameFilters(), false))), false, 'select-all leaves the gate off');

  let isolated = onlyFilter(defaultFrameFilters(), 'question');
  assert.equal(wantsHiddenFrames(isolated), false, 'Ctrl+Click on Question does not reveal hidden frames');
});

test('Ctrl+Click on the gate reveals hidden frames without emptying the categories', () => {
  let onlyGate = onlyFilter(defaultFrameFilters(), 'hidden');
  assert.equal(onlyGate.hidden, true, 'the gate turns on');
  assert.equal(everyFilterOn(onlyGate), true, 'the categories are left on, so something is still visible');
  assert.equal(filterSummary(onlyGate), 'on');
});

test('filterCounts counts categories and hidden frames separately', () => {
  let frames = [
    { type: 'UserMessage', authorType: 'user' },
    { type: 'AgentMessage', authorType: 'agent' },
    { type: 'Question', authorType: 'agent' },
    { type: 'ToolCall' },
    { type: 'CompactionFrame' },
    { type: 'UserMessage', authorType: 'user', hidden: true },
  ];
  let counts = filterCounts(frames);
  assert.equal(counts.user, 2, 'the hidden message is still a User frame');
  assert.equal(counts.agent, 2);
  assert.equal(counts.question, 1);
  assert.equal(counts.tools, 1);
  assert.equal(counts.compaction, 1);
  assert.equal(counts.commands, 0);
  assert.equal(counts.hidden, 1, 'and it is also counted as Hidden');
  for (let key of FILTER_KEYS)
    assert.equal(typeof counts[key], 'number');
});

test('the signature changes only when a filter actually flips', () => {
  let filters = defaultFrameFilters();
  assert.equal(frameFiltersSignature(filters), frameFiltersSignature(defaultFrameFilters()));
  assert.notEqual(frameFiltersSignature(filters), frameFiltersSignature(toggleFilter(filters, 'tools')));
  assert.equal(frameFiltersSignature(filters).length, FILTER_KEYS.length);
});
