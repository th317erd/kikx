'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerCaretAllowsHistory,
  composerHistoryDirectionForKey,
  composerHistoryEntriesFromFrames,
  createComposerHistoryState,
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
} from '../../src/client/components/composer-history.mjs';

function historyWith(...messages) {
  let history = createComposerHistoryState();
  for (let message of messages)
    recordComposerHistoryEntry(history, message);
  return history;
}

test('records sent messages in submission order', () => {
  let history = historyWith('first', 'second', 'third');
  assert.deepEqual(history.entries, [ 'first', 'second', 'third' ]);
  assert.equal(history.cursor, -1);
  assert.equal(history.draft, '');
});

test('ignores blank and non-string messages', () => {
  let history = historyWith('keep', '   ', '', null, undefined);
  assert.deepEqual(history.entries, [ 'keep' ]);
});

test('ArrowUp recalls newest message then walks toward older ones', () => {
  let history = historyWith('oldest', 'middle', 'newest');

  assert.deepEqual(navigateComposerHistory(history, 'up', 'in progress'), { handled: true, value: 'newest' });
  assert.equal(history.draft, 'in progress');

  assert.deepEqual(navigateComposerHistory(history, 'up', 'newest'), { handled: true, value: 'middle' });
  assert.deepEqual(navigateComposerHistory(history, 'up', 'middle'), { handled: true, value: 'oldest' });
});

test('ArrowUp at the oldest entry stays on the oldest entry', () => {
  let history = historyWith('only');
  assert.deepEqual(navigateComposerHistory(history, 'up', ''), { handled: true, value: 'only' });
  assert.deepEqual(navigateComposerHistory(history, 'up', 'only'), { handled: true, value: 'only' });
});

test('ArrowDown walks forward and restores the in-progress draft', () => {
  let history = historyWith('oldest', 'newest');
  navigateComposerHistory(history, 'up', 'my draft');
  navigateComposerHistory(history, 'up', 'newest');
  assert.equal(history.cursor, 0);

  assert.deepEqual(navigateComposerHistory(history, 'down', 'oldest'), { handled: true, value: 'newest' });
  assert.deepEqual(navigateComposerHistory(history, 'down', 'newest'), { handled: true, value: 'my draft' });
  assert.equal(history.cursor, -1);
  assert.equal(history.draft, '');
});

test('ArrowDown is not handled while editing the live draft', () => {
  let history = historyWith('only');
  assert.deepEqual(navigateComposerHistory(history, 'down', 'typing'), { handled: false, value: null });
});

test('ArrowUp is not handled when history is empty', () => {
  let history = createComposerHistoryState();
  assert.deepEqual(navigateComposerHistory(history, 'up', 'typing'), { handled: false, value: null });
});

test('recording a message resets navigation state', () => {
  let history = historyWith('one');
  navigateComposerHistory(history, 'up', 'draft');
  recordComposerHistoryEntry(history, 'two');
  assert.equal(history.cursor, -1);
  assert.equal(history.draft, '');
  assert.deepEqual(history.entries, [ 'one', 'two' ]);
});

test('resetComposerHistoryNavigation clears cursor and saved draft', () => {
  let history = historyWith('one');
  navigateComposerHistory(history, 'up', 'draft');
  resetComposerHistoryNavigation(history);
  assert.equal(history.cursor, -1);
  assert.equal(history.draft, '');
});

test('composerHistoryDirectionForKey maps plain arrows only', () => {
  assert.equal(composerHistoryDirectionForKey({ key: 'ArrowUp' }), 'up');
  assert.equal(composerHistoryDirectionForKey({ key: 'ArrowDown' }), 'down');
  assert.equal(composerHistoryDirectionForKey({ key: 'ArrowUp', shiftKey: true }), null);
  assert.equal(composerHistoryDirectionForKey({ key: 'ArrowDown', ctrlKey: true }), null);
  assert.equal(composerHistoryDirectionForKey({ key: 'ArrowUp', isComposing: true }), null);
  assert.equal(composerHistoryDirectionForKey({ key: 'a' }), null);
  assert.equal(composerHistoryDirectionForKey(null), null);
});

test('composerCaretAllowsHistory respects line boundaries', () => {
  assert.equal(composerCaretAllowsHistory('up', 'single line', 0), true);
  assert.equal(composerCaretAllowsHistory('down', 'single line', 11), true);

  let multi = 'first\nsecond';
  assert.equal(composerCaretAllowsHistory('up', multi, 3), true);
  assert.equal(composerCaretAllowsHistory('up', multi, 8), false);
  assert.equal(composerCaretAllowsHistory('down', multi, 8), true);
  assert.equal(composerCaretAllowsHistory('down', multi, 3), false);
});

test('composerHistoryEntriesFromFrames derives user messages in order', () => {
  let frames = [
    { authorType: 'user', content: { text: 'first' } },
    { authorType: 'agent', type: 'AgentMessage', content: { text: 'reply' } },
    { authorType: 'user', content: { text: '  second  ' } },
    { authorType: 'user', content: { text: '   ' } },
    { authorType: 'user', contentText: 'third' },
    { authorType: 'user', content: { text: 'gone' }, hidden: true },
    { authorType: 'user', content: { text: 'gone2' }, deleted: true },
  ];
  assert.deepEqual(composerHistoryEntriesFromFrames(frames), [ 'first', 'second', 'third' ]);
});

test('composerHistoryEntriesFromFrames tolerates junk input', () => {
  assert.deepEqual(composerHistoryEntriesFromFrames(null), []);
  assert.deepEqual(composerHistoryEntriesFromFrames(undefined), []);
  assert.deepEqual(composerHistoryEntriesFromFrames([ null, undefined, {} ]), []);
});
