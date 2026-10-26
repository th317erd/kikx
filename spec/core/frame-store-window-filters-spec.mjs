'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_FILTER_CATEGORY_KEYS,
  FRAME_FILTER_ROWS,
  defaultFrameWindowFilters,
  frameFilterCategories,
  frameFilterCounts,
  frameMatchesQuery,
  frameMatchesWindowFilters,
  frameQueryMatchesText,
  frameSearchText,
  frameTypeFromPath,
  frameTypesForFilters,
  normalizeFrameQuery,
  normalizeWindowFilters,
  pathMatchesTypes,
  windowFiltersAreDefault,
} from '../../src/shared/frame-window-filters.mjs';

function framePathFor(order, type, id) {
  return `/kikx/sessions/s1/interactions/i1/frames/${String(order).padStart(16, '0')}-${type}-${id}.json`;
}

function allOn() {
  let filters = {};
  for (let row of FRAME_FILTER_ROWS)
    filters[row.key] = true;

  return filters;
}

function only(...keys) {
  let filters = {};
  for (let row of FRAME_FILTER_ROWS)
    filters[row.key] = keys.includes(row.key);

  return filters;
}

function msg(overrides = {}) {
  return {
    id: 'f_1',
    type: 'UserMessage',
    authorType: 'user',
    content: { text: 'hello' },
    ...overrides,
  };
}

// --- defaults -------------------------------------------------------------

test('categories default on and the deleted gate defaults off', () => {
  let defaults = defaultFrameWindowFilters();

  for (let key of FRAME_FILTER_CATEGORY_KEYS)
    assert.equal(defaults[key], true, `${key} should default on`);

  assert.equal(defaults.deleted, false, 'deleted must default off');

  // Turning the gate on by default would dump drafts, frame groups, deadline
  // schedules and undispatched invites into every thread.
  assert.ok(!JSON.stringify(defaults).includes('hidden'), 'hidden is not a user-facing row');
});

test('normalizeWindowFilters keeps booleans, defaults the rest, drops unknown keys', () => {
  let normalized = normalizeWindowFilters({ user: false, agent: 'yes', deleted: true, bogus: true });

  assert.equal(normalized.user, false);
  assert.equal(normalized.agent, true, 'a non-boolean falls back to its default');
  assert.equal(normalized.deleted, true);
  assert.ok(!('bogus' in normalized), 'unknown keys are dropped');
});

test('normalizeWindowFilters tolerates null and junk', () => {
  assert.deepEqual(normalizeWindowFilters(null), defaultFrameWindowFilters());
  assert.deepEqual(normalizeWindowFilters('nope'), defaultFrameWindowFilters());
  assert.deepEqual(normalizeWindowFilters(undefined), defaultFrameWindowFilters());
});

test('windowFiltersAreDefault treats the untouched view as the fast path', () => {
  assert.equal(windowFiltersAreDefault(null), true);
  assert.equal(windowFiltersAreDefault(defaultFrameWindowFilters()), true);
  assert.equal(windowFiltersAreDefault(defaultFrameWindowFilters(), '   '), true);

  assert.equal(windowFiltersAreDefault(only('user')), false);
  assert.equal(windowFiltersAreDefault(null, 'hello'), false);
});

// --- hidden / phantom gates ------------------------------------------------

test('hidden frames are never visible, even with every row on', () => {
  let hidden = msg({ hidden: true });

  assert.equal(frameMatchesWindowFilters(hidden, allOn()), false);
  assert.equal(frameMatchesWindowFilters(hidden, only('user')), false);
  assert.equal(frameMatchesWindowFilters(hidden, only()), false);
});

test('phantom frames and MessageDone are never visible', () => {
  assert.equal(frameMatchesWindowFilters(msg({ phantom: true }), allOn()), false);
  assert.equal(frameMatchesWindowFilters(msg({ type: 'MessageDone' }), allOn()), false);
});

test('frame identity is a rendering concern, not a visibility one', () => {
  // The thread keys items by `data-frame-id`, but selection must not depend on
  // identity: a partially hydrated body still belongs to the session, and
  // dropping it here would make a filtered window disagree with the server's
  // counts for the same session. Renderability is enforced where the frame is
  // placed, not in the predicate -- see the ordering comment above.
  assert.equal(frameMatchesWindowFilters(msg({ id: '' }), allOn()), true);
  assert.equal(frameMatchesWindowFilters(msg({ id: undefined }), allOn()), true);
});

// --- the deleted gate (the user's worked examples) ------------------------

test('a soft-deleted session needs the Deleted gate', () => {
  let deletedSession = {
    id: 'f_ses',
    type: 'Session',
    content: { title: 'Renamed away' },
    deleted: true,
  };

  // Ctrl-click Sessions: live sessions only.
  assert.equal(frameMatchesWindowFilters(deletedSession, only('session')), false);

  // Ctrl-click Sessions, then also click Deleted: the deleted session appears.
  assert.equal(frameMatchesWindowFilters(deletedSession, only('session', 'deleted')), true);
});

test('a soft-deleted user message needs the Deleted gate', () => {
  let deletedMessage = msg({ deleted: true });

  assert.equal(frameMatchesWindowFilters(deletedMessage, only('user')), false);
  assert.equal(frameMatchesWindowFilters(deletedMessage, only('user', 'deleted')), true);
});

test('the Deleted gate alone does not resurrect a hidden frame', () => {
  // redactUserMessageFrame sets hidden AND deleted together
  // (frame-runtime-composer.mjs:102-103). Hidden stays absolute.
  let redacted = msg({ hidden: true, deleted: true });

  assert.equal(frameMatchesWindowFilters(redacted, only('user', 'deleted')), false);
});

test('live frames are not hidden by the Deleted gate being off', () => {
  assert.equal(frameMatchesWindowFilters(msg(), only('user')), true);
});

// --- categories -----------------------------------------------------------

test('categories are ANY-of, so a Question by an agent matches either row', () => {
  let question = { id: 'f_q', type: 'Question', authorType: 'agent', content: { text: 'Which?' } };

  assert.deepEqual(frameFilterCategories(question), ['agent', 'question']);
  assert.equal(frameMatchesWindowFilters(question, only('question')), true);
  assert.equal(frameMatchesWindowFilters(question, only('agent')), true);
  assert.equal(frameMatchesWindowFilters(question, only('user')), false);
});

test('categories come back in popup display order, not insertion order', () => {
  let childSession = { id: 'f_s', type: 'AgentMessage', authorType: 'agent', content: { references: [ { type: 'session' } ] } };

  assert.deepEqual(frameFilterCategories(childSession), ['agent', 'session']);
});

test('a session reference makes a frame count as Child Sessions', () => {
  let referencing = msg({ content: { text: 'look', references: [ { type: 'session', id: 's2' } ] } });

  // The row is defined by `content.references[].type === 'session'`, so a user
  // message that raises a child session is reachable under Child Sessions as
  // well as under User. Categories are ANY-of.
  assert.deepEqual(frameFilterCategories(referencing), ['user', 'session']);
  assert.equal(frameMatchesWindowFilters(referencing, only('session', 'user')), true);
  assert.equal(frameMatchesWindowFilters(referencing, only('user')), true);
  assert.equal(frameMatchesWindowFilters(referencing, only('session')), true);
  assert.equal(frameMatchesWindowFilters(referencing, only('agent')), false);

  // A reference of another type must not create a Child Sessions match.
  let toolRef = msg({ content: { text: 'look', references: [ { type: 'url', id: 'u1' } ] } });
  assert.deepEqual(frameFilterCategories(toolRef), ['user']);
  assert.equal(frameMatchesWindowFilters(toolRef, only('session')), false);
});

test('an uncategorised frame follows whether any category is on', () => {
  let odd = { id: 'f_o', type: 'SomethingElse', content: {} };

  assert.deepEqual(frameFilterCategories(odd), []);
  assert.equal(frameMatchesWindowFilters(odd, only('user')), true);
  assert.equal(frameMatchesWindowFilters(odd, only()), false);
});

test('tool frames fall under Tools and commands under Commands', () => {
  assert.equal(frameMatchesWindowFilters({ id: 'a', type: 'ToolCall', content: {} }, only('tools')), true);
  assert.equal(frameMatchesWindowFilters({ id: 'b', type: 'ToolResult', content: {} }, only('tools')), true);
  assert.equal(frameMatchesWindowFilters({ id: 'c', type: 'CommandResult', content: {} }, only('commands')), true);
  assert.equal(frameMatchesWindowFilters({ id: 'd', type: 'CompactionFrame', content: {} }, only('compaction')), true);
});

// --- path pushdown --------------------------------------------------------

test('frameTypeFromPath reads the type out of the encoded filename', () => {
  assert.equal(frameTypeFromPath(framePathFor(5, 'ToolCall', 'f_abc')), 'ToolCall');
  assert.equal(frameTypeFromPath(framePathFor(0, 'UserMessage', 'f_1')), 'UserMessage');
  assert.equal(frameTypeFromPath('/kikx/sessions/s1/session.json'), '');
});

test('a single selected category narrows to exactly one frame type', () => {
  assert.deepEqual(frameTypesForFilters(only('question')), ['Question']);
  assert.deepEqual(frameTypesForFilters(only('compaction')), ['CompactionFrame']);
});

test('shape-matched categories cannot be narrowed to a type list', () => {
  // Tools and Commands are matched by *shape* -- `ToolCall`/`ToolResult` plus
  // every concrete `<Name>ToolFrame`, and `ShellToolFrame`/`CommandResult`.
  // Enumerating types here would reject real frames: a session storing 12,564
  // `ShellToolFrame` rows reported Tools = 0 and Commands = 0 for exactly this
  // reason. `null` means "no type constraint", so the scan walks every path and
  // the hydrated predicate decides.
  assert.equal(frameTypesForFilters(only('tools')), null);
  assert.equal(frameTypesForFilters(only('commands')), null);
});

test('a category that depends on frame content cannot be type-narrowed', () => {
  // Child Sessions also matches frames that merely reference a session, which
  // the path cannot express, so the type set must stay unconstrained.
  assert.equal(frameTypesForFilters(only('session')), null);
});

test('an empty category selection admits no type at all', () => {
  assert.deepEqual(frameTypesForFilters(only()), []);
});

test('default filters impose no type constraint', () => {
  assert.equal(frameTypesForFilters(defaultFrameWindowFilters()), null);
});

test('pathMatchesTypes excludes only what it can prove', () => {
  let path = framePathFor(9, 'ToolCall', 'f_x');

  assert.equal(pathMatchesTypes(path, null), true, 'null means unconstrained');
  assert.equal(pathMatchesTypes(path, [ 'ToolCall', 'ToolResult' ]), true);
  assert.equal(pathMatchesTypes(path, [ 'UserMessage' ]), false);
  assert.equal(pathMatchesTypes(path, []), false, 'no admitted type, no match');

  // An unparseable name must not be treated as a match when a type is required.
  assert.equal(pathMatchesTypes('/kikx/sessions/s1/session.json', [ 'ToolCall' ]), false);
});

// --- the generalized search ----------------------------------------------

test('frameQueryMatchesText is case-insensitive fuzzy matching when there is no wildcard', () => {
  assert.equal(frameQueryMatchesText('Rename the session', 'rename'), true);
  assert.equal(frameQueryMatchesText('Rename the session', 'RENAME'), true);
  assert.equal(frameQueryMatchesText('Rename the session', 'delete'), false);
  assert.equal(frameQueryMatchesText('anything', ''), true);
  assert.equal(frameQueryMatchesText('frame filter popup', 'frmfltr'), true);
  assert.equal(frameQueryMatchesText('Rename the session', 'rn ss'), true);
  assert.equal(frameQueryMatchesText('frame filter popup', 'frm zzz'), false);
});

test('frameQueryMatchesText honours * as a wildcard in order', () => {
  assert.equal(frameQueryMatchesText('ToolCall', 'tool*call'), true);
  assert.equal(frameQueryMatchesText('ToolCall', 'call*tool'), false, 'segments must appear in order');
  assert.equal(frameQueryMatchesText('ToolResult', 'tool*'), true);
  assert.equal(frameQueryMatchesText('ToolResult', '*result'), true);
  assert.equal(frameQueryMatchesText('ToolResult', 'tool*zzz'), false);
  assert.equal(frameQueryMatchesText('ToolResult', '*'), true);
});

test('frameQueryMatchesText treats regex metacharacters as literals', () => {
  assert.equal(frameQueryMatchesText('a.b', 'a.b'), true);
  assert.equal(frameQueryMatchesText('axb', 'a.b'), false, 'the dot is not a wildcard');
  assert.equal(frameQueryMatchesText('cost is $5', '$5'), true);
  assert.equal(frameQueryMatchesText('path C:\\tmp', 'c:\\tmp'), true);
});

test('frameSearchText covers message text, titles, tool names and references', () => {
  let frame = {
    id: 'f_1',
    type: 'ToolCall',
    content: {
      toolName: 'search_sessions',
      text: 'find it',
      references: [ { type: 'session', title: 'Deploy notes', id: 's9' } ],
    },
  };

  let haystack = frameSearchText(frame);
  assert.ok(haystack.includes('find it'));
  assert.ok(haystack.includes('search_sessions'));
  assert.ok(haystack.includes('Deploy notes'));
  assert.ok(haystack.includes('ToolCall'));
});

test('the query narrows within the selected categories', () => {
  let frame = msg({ content: { text: 'deploy the thing' } });

  assert.equal(frameMatchesQuery(frame, 'deploy'), true);
  assert.equal(frameMatchesQuery(frame, 'rollback'), false);
  assert.equal(frameMatchesWindowFilters(frame, only('user'), 'deploy'), true);
  assert.equal(frameMatchesWindowFilters(frame, only('user'), 'rollback'), false);
  assert.equal(frameMatchesWindowFilters(frame, only('agent'), 'deploy'), false);
});

test('normalizeFrameQuery collapses whitespace and caps length', () => {
  assert.equal(normalizeFrameQuery('  a   b  '), 'a b');
  assert.equal(normalizeFrameQuery(null), '');
  assert.equal(normalizeFrameQuery(42), '');
  assert.equal(normalizeFrameQuery('x'.repeat(500)).length, 200);
});

// --- counts ---------------------------------------------------------------

test('filterCounts badge every row and skip what cannot be revealed', () => {
  let frames = [
    msg(),
    msg({ id: 'f_2', deleted: true }),
    msg({ id: 'f_3', hidden: true }),
    msg({ id: 'f_4', type: 'MessageDone' }),
    { id: 'f_5', type: 'Question', authorType: 'agent', content: {} },
  ];

  let counts = frameFilterCounts(frames);

  assert.equal(counts.user, 2, 'live + deleted user, not the hidden one');
  assert.equal(counts.deleted, 1);
  assert.equal(counts.question, 1);
  assert.equal(counts.agent, 1);
  assert.equal(counts.tools, 0);
});

test('filterCounts tolerates junk input', () => {
  let counts = frameFilterCounts(null);
  for (let row of FRAME_FILTER_ROWS)
    assert.equal(counts[row.key], 0);
});
