'use strict';

// Regression: an open view (Inbox, Activities) was rebuilt by every unrelated
// runtime event, and the Inbox could not repaint an empty <-> non-empty change
// without the caller tearing down the whole shell.
//
// Both defects produced the same user-visible symptoms, reported together:
//
//   * "If a bot is actively working (SSE events), this Inbox page jitters,
//     jumps, resets, wipes my in-progress responses."
//   * "If I answer a question, it answers, blinks back to not being answered,
//     and then suddenly is answered again."
//   * "It doesn't CLEAR what I am typing — it just BLURs the field and jacks my
//     caret away from me."
//
// The mechanism was not the Inbox's own reconciliation, which was already
// careful. It was `syncSessionShell` returning `false` whenever a view owned
// the work area — because `buildRunnerShell` replaces `buildWindow` (and its
// thread title and session grid) with the view, so every lookup missed. Callers
// are written `if (!app._syncSessionShell()) app._requestRender();`, so a single
// `session.saved` from ANY session rebuilt the entire app.
//
// `renderAppShell` does `$(app).empty()` and rebuilds from new nodes, and
// `bindAnswerForm` restores typed text from the draft store into the NEW
// textarea. That is exactly why the text survived while the caret did not: the
// node was replaced, not edited.
//
// The guarantee these tests defend: an event that cannot change the surface on
// screen must never be answered with "rebuild everything", and the Inbox must be
// able to move between empty and non-empty without a caller rebuild.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const { syncSessionShell } = await import('../../src/client/components/kikx-frame-scroll.mjs');
const { buildInboxList, syncInboxList } = await import('../../src/client/components/kikx-inbox-list.mjs');
const { buildInboxView } = await import('../../src/client/components/kikx-inbox-view.mjs');
const { createQuestionsState } = await import('../../src/client/state/questions-state.mjs');
const { createNavigationStack, pushView } = await import('../../src/client/state/navigation-stack.mjs');

// --- helpers ---------------------------------------------------------------

function question(overrides = {}) {
  return {
    id: 'q_1',
    status: 'open',
    mode: 'wait',
    text: 'Which database should we use?',
    priority: 'normal',
    askedAt: 1000,
    sessionID: 'ses_1',
    agentID: 'agent-1',
    ...overrides,
  };
}

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object')
    return found;

  if (predicate(node))
    found.push(node);

  for (let child of node.childNodes || [])
    walk(child, predicate, found);

  return found;
}

function byClass(root, className) {
  return walk(root, (node) => String(node.className || '').split(/\s+/).includes(className));
}

function cardsOf(root) {
  return byClass(root, 'kikx-question-card');
}

/**
 * Mount the Inbox the way `renderAppShell` does: a `.kikx-inbox` section with a
 * header (carrying the count) and either a list or the empty state.
 *
 * The app double only answers the selectors the real code asks for; anything
 * else returns null, exactly like `querySelector` on a surface that is absent.
 */
function mountInbox(questions, { stack = null } = {}) {
  let questionsState = createQuestionsState();
  questionsState.questions = questions;
  questionsState.counts = { open: questions.length };

  // The app element CONTAINS the Inbox section, as the real shell does; the code
  // under test finds its surface with `app.querySelector('.kikx-inbox')`.
  let root = document.createElement('div');
  root.className = 'kikx-app';
  root._state = {
    questionsState,
    selectedSessionID: 'ses_1',
    navigationStack: stack || pushView(createNavigationStack(), 'inbox'),
    sessionIDs: [],
    sessionDetailsByID: {},
  };

  let screen = document.createElement('section');
  screen.className = 'kikx-inbox';
  root.appendChild(screen);

  let app = Object.assign(root, {
    ownerDocument: document,
  });

  // Use the real view builder so the mounted markup is what production renders,
  // then move its children into the section the app already holds.
  let view = buildInboxView(app);
  for (let child of [ ...view.childNodes ])
    screen.appendChild(child);

  return { app, screen, questionsState };
}

// --- syncSessionShell ------------------------------------------------------

test('syncSessionShell claims a view surface instead of forcing a full rebuild', () => {
  // The whole defect: while a view is on top there is no thread title and no
  // session grid, so the old code fell through to `return false` and every
  // `session.saved` rebuilt the app underneath the user. Claiming the repaint is
  // correct because the view owns the work area and the sidebar badge is the
  // only surface an event can still touch.
  let root = document.createElement('div');
  root.className = 'kikx-app';
  root._state = {
    navigationStack: pushView(createNavigationStack(), 'inbox'),
    selectedSessionID: '',
    sessionIDs: [],
    sessionDetailsByID: {},
  };

  assert.equal(
    syncSessionShell(root),
    true,
    'a view-owned work area must not report "unhandled", or the caller rebuilds the whole app',
  );
});

test('syncSessionShell also claims the Activities view', () => {
  // Same reasoning, same surface rule: the fix is about views, not about Inbox.
  let root = document.createElement('div');
  root.className = 'kikx-app';
  root._state = {
    navigationStack: pushView(createNavigationStack(), 'activities'),
    selectedSessionID: '',
    sessionIDs: [],
    sessionDetailsByID: {},
  };

  assert.equal(syncSessionShell(root), true);
});

test('syncSessionShell still reports unhandled when a session surface is missing', () => {
  // The guard must stay narrow. With a session on top and no thread title or
  // grid rendered, there is genuinely nothing to repaint and the caller's
  // rebuild is the honest answer.
  let root = document.createElement('div');
  root.className = 'kikx-app';
  root._state = {
    navigationStack: createNavigationStack(),
    selectedSessionID: 'ses_1',
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: { ses_1: { id: 'ses_1', title: 'A session' } },
  };

  assert.equal(syncSessionShell(root), false);
});

// --- syncInboxList: empty <-> non-empty, in place --------------------------

test('answering the last question swaps in the empty state without a caller rebuild', () => {
  let { app, screen, questionsState } = mountInbox([ question({ id: 'q_1' }) ]);

  assert.equal(cardsOf(screen).length, 1, 'the question rendered');

  questionsState.questions = [];
  questionsState.counts = { open: 0 };

  assert.equal(
    syncInboxList(app, {}),
    true,
    'the list must be able to go empty on its own; `false` means a whole-app rebuild',
  );

  assert.equal(cardsOf(screen).length, 0, 'the answered card is gone');
  assert.ok(
    byClass(screen, 'kikx-inbox-empty').length >= 1,
    'the empty state is rendered in place',
  );
  assert.equal(screen.querySelector('.kikx-inbox-header__count')?.textContent, '0');
});

test('a first question arriving while the empty state is shown swaps in the list', () => {
  let { app, screen, questionsState } = mountInbox([]);

  assert.equal(cardsOf(screen).length, 0, 'nothing is waiting yet');
  assert.ok(byClass(screen, 'kikx-inbox-empty').length >= 1, 'the empty state is shown');

  questionsState.questions = [ question({ id: 'q_late' }) ];
  questionsState.counts = { open: 1 };

  assert.equal(
    syncInboxList(app, {}),
    true,
    'a new question must render without rebuilding the whole shell',
  );

  let cards = cardsOf(screen);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute('data-question-id'), 'q_late');
  assert.equal(
    byClass(screen, 'kikx-inbox-empty').length,
    0,
    'the empty state was replaced, not left alongside the list',
  );
});

test('an empty Inbox with no list is already correct and needs no rebuild', () => {
  // Answering the last question twice must be idempotent: the second sync finds
  // the empty state and no list, which is the desired end state.
  let { app } = mountInbox([]);

  assert.equal(syncInboxList(app, {}), true);
});

test('a list repaint still leaves untouched cards, and their caret, alone', () => {
  // The narrower guarantee the in-place path exists for: a still-open question's
  // textarea must be the SAME node after a repaint. Identity is what keeps focus
  // and the caret alive; text equality alone would not.
  let { app, screen, questionsState } = mountInbox([
    question({ id: 'q_1', index: 1, groupID: 'g', text: 'First?' }),
    question({ id: 'q_2', index: 2, groupID: 'g', text: 'Second?' }),
  ]);

  let before = cardsOf(screen).find((card) => card.getAttribute('data-question-id') === 'q_2');
  let input = byClass(before, 'kikx-question-card__input')[0];
  input.value = 'half-typed answer';

  questionsState.questions = [ question({ id: 'q_2', index: 2, groupID: 'g', text: 'Second?' }) ];

  assert.equal(syncInboxList(app, {}), true);

  let after = cardsOf(screen).find((card) => card.getAttribute('data-question-id') === 'q_2');
  assert.equal(after, before, 'the surviving card is the same DOM node, not a replacement');
  assert.equal(
    byClass(after, 'kikx-question-card__input')[0].value,
    'half-typed answer',
    'the typed text was never re-created from the draft store',
  );
});
