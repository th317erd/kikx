'use strict';

// Draft preservation across an Inbox repaint (the reported bug).
//
// The bug: answering one question in a two-question batch wiped the text typed
// into BOTH cards, and the answered row stayed on screen until a server event
// happened to arrive. Both failures came from the same place — every question
// mutation called `app._requestRender()`, a full shell rebuild that re-creates
// every textarea and throws the DOM values away.
//
// The guarantee these tests defend: reconciling the list must never destroy the
// contents of a box belonging to a question that is still open, and an answered
// question must leave the list immediately (local action, not server event).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { buildInboxList, syncInboxList } = await import('../../src/client/components/kikx-inbox-list.mjs');
const { renderQuestionCard, bindAnswerForm } = await import('../../src/client/components/kikx-question-card.mjs');
const { applyLocalAnswer, applyLocalRead } = await import('../../src/client/state/questions-local-state.mjs');
const { createQuestionsState, reconcileQuestions, applyQuestionsFetch, applyQuestionEvent } =
  await import('../../src/client/state/questions-state.mjs');

const CARD = 'kikx-question-card';
const INPUT = 'kikx-question-card__input';
const SUBMIT = 'kikx-question-card__submit';

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

function batch() {
  return [
    question({ id: 'q_1', index: 1, groupID: 'group_1', text: 'First question?' }),
    question({ id: 'q_2', index: 2, groupID: 'group_1', text: 'Second question?' }),
  ];
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
  return byClass(root, CARD);
}

function inputOf(card) {
  return byClass(card, INPUT)[0];
}

// A DOM-backed app double: the real `syncInboxList` addresses the rendered tree
// through `querySelector`/`querySelectorAll`, exactly as the running app does.
function mountApp(questions) {
  let questionsState = createQuestionsState();
  questionsState.questions = questions;
  questionsState.counts = { open: questions.length };

  let screen = document.createElement('div');
  screen.className = 'kikx-inbox';

  let app = {
    _state: { questionsState },
    ownerDocument: document,
    querySelector(selector) {
      if (selector === '.kikx-inbox')
        return screen;

      return screen.querySelector(selector);
    },
    querySelectorAll(selector) {
      return screen.querySelectorAll(selector);
    },
  };

  let list = buildInboxList(app, {});
  screen.appendChild(list);
  return { app, screen, questionsState };
}

test('a repaint after one answer keeps the other card\'s typed answer intact', () => {
  let { app, screen, questionsState } = mountApp(batch());

  let [ firstCard, secondCard ] = cardsOf(screen);
  assert.ok(firstCard && secondCard, 'both cards rendered');

  inputOf(firstCard).value = 'Use PostgreSQL';
  inputOf(secondCard).value = 'Keep the sidebar flat';

  // Answer the FIRST question. This is what `submitQuestionAnswer` now does.
  applyLocalAnswer(questionsState, 'q_1');

  assert.equal(syncInboxList(app, {}), true, 'the list reconciles in place');

  let remaining = cardsOf(screen);
  assert.equal(remaining.length, 1, 'only the answered card is gone');
  assert.equal(remaining[0].getAttribute('data-question-id'), 'q_2');
  assert.equal(
    inputOf(remaining[0]).value,
    'Keep the sidebar flat',
    'the unanswered card keeps the text the user typed into it',
  );
});

test('a repaint after an unrelated read changes nothing the user typed', () => {
  let { app, screen, questionsState } = mountApp(batch());

  let [ firstCard, secondCard ] = cardsOf(screen);
  inputOf(firstCard).value = 'draft one';
  inputOf(secondCard).value = 'draft two';

  applyLocalRead(questionsState, 'q_1');
  assert.equal(syncInboxList(app, {}), true);

  let remaining = cardsOf(screen);
  assert.equal(remaining.length, 2, 'a read removes nothing');
  assert.equal(inputOf(remaining[0]).value, 'draft one');
  assert.equal(inputOf(remaining[1]).value, 'draft two');
});

test('answering one question of a batch removes only that row, immediately', () => {
  let { app, screen, questionsState } = mountApp(batch());

  assert.equal(cardsOf(screen).length, 2);

  applyLocalAnswer(questionsState, 'q_1');

  // No server event, no fetch: the list must already agree that q_1 is gone.
  assert.equal(questionsState.questions.length, 1);
  assert.equal(questionsState.questions[0].id, 'q_2');
  assert.equal(questionsState.counts.open, 1);

  assert.equal(syncInboxList(app, {}), true);
  assert.equal(cardsOf(screen).length, 1);
});

test('a fetch issued before an answer cannot resurrect the answered question', () => {
  let state = createQuestionsState();
  state.questions = batch();

  // The fetch was issued before the answer and lands after it.
  applyLocalAnswer(state, 'q_1');

  applyQuestionsFetch(state, { questions: batch() }, { complete: true });

  assert.deepEqual(
    state.questions.map((entry) => entry.id),
    [ 'q_2' ],
    'the answered question stays closed even though the payload still lists it',
  );
});

test('a paginated fetch cannot resurrect an answered question either', () => {
  let state = createQuestionsState();
  state.questions = batch();
  applyLocalAnswer(state, 'q_1');

  applyQuestionsFetch(state, { questions: batch() }, { complete: false });

  assert.deepEqual(state.questions.map((entry) => entry.id), [ 'q_2' ]);
});

test('a late question.asked event cannot re-open an answered question', () => {
  let state = createQuestionsState();
  state.questions = batch();
  applyLocalAnswer(state, 'q_1');

  applyQuestionEvent(state, {
    type: 'question.asked',
    payload: { questions: [ question({ id: 'q_1', text: 'First question?' }) ] },
  });

  assert.deepEqual(state.questions.map((entry) => entry.id), [ 'q_2' ]);
});

test('reconcileQuestions honours an explicit exclusion set', () => {
  let merged = reconcileQuestions([], batch(), {
    complete: true,
    exclude: new Set([ 'q_1' ]),
  });

  assert.deepEqual(merged.map((entry) => entry.id), [ 'q_2' ]);
});

test('the closed set is bounded so a long-lived tab cannot grow without limit', () => {
  let state = createQuestionsState();
  let { MAX_CLOSED_QUESTION_IDS } = { MAX_CLOSED_QUESTION_IDS: 500 };

  for (let index = 0; index < MAX_CLOSED_QUESTION_IDS + 5; index++)
    applyLocalAnswer(state, `q_${index}`);

  assert.equal(state.closedQuestionIDs.size, MAX_CLOSED_QUESTION_IDS);
});

test('syncInboxList refuses to repaint when the list is not on screen', () => {
  let state = createQuestionsState();
  state.questions = batch();

  let app = {
    _state: { questionsState: state },
    ownerDocument: document,
    querySelector() {
      return null;
    },
  };

  assert.equal(syncInboxList(app, {}), false, 'caller falls back to a full render');
});

test('a card created by the repaint is wired, not inert', async () => {
  let { app, screen, questionsState } = mountApp([ question({ id: 'q_1' }) ]);

  let submitted = [];
  let handlers = { onSubmit: (questionID, text) => { submitted.push([ questionID, text ]); } };

  // A second question arrives live; the repaint must bind its form.
  questionsState.questions = [ ...questionsState.questions, question({ id: 'q_9', text: 'Late question?' }) ];

  assert.equal(syncInboxList(app, handlers), true);

  let lateCard = cardsOf(screen).find((card) => card.getAttribute('data-question-id') === 'q_9');
  assert.ok(lateCard, 'the late question rendered');

  inputOf(lateCard).value = 'a real answer';
  let form = walk(lateCard, (node) => String(node.tagName || '').toUpperCase() === 'FORM')[0];
  assert.ok(form, 'the late card has a form');
  form.dispatchEvent({ type: 'submit', preventDefault() {} });

  await Promise.resolve();
  assert.deepEqual(submitted, [ [ 'q_9', 'a real answer' ] ], 'the late card submits');
});

test('renderQuestionCard still emits the ids the repaint addresses rows by', () => {
  let card = renderQuestionCard({ ownerDocument: document }, question(), { now: 2000 });
  assert.ok(card);
  assert.equal(card.getAttribute('data-question-id'), 'q_1');
  assert.equal(card.getAttribute('data-question-status'), 'open');
  assert.ok(byClass(card, INPUT).length === 1);
  assert.ok(byClass(card, SUBMIT).length === 1);

  // bindAnswerForm is what makes the box live; assert it is importable and
  // tolerant of a node without a form (a terminal row renders read-only).
  bindAnswerForm(card, {});
});

test('answering through the view repaints in place instead of rebuilding the shell', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let screen = document.createElement('div');
  screen.className = 'kikx-inbox';

  let questionsState = createQuestionsState();
  questionsState.questions = batch();
  questionsState.counts = { open: 2 };

  let renders = 0;
  let posted = [];

  let app = {
    _state: { questionsState },
    ownerDocument: document,
    _postJSON: async (url) => {
      posted.push(url);
      return { data: { question: { id: 'q_1', status: 'answered' }, delivered: true } };
    },
    _requestRender: () => { renders += 1; },
    _syncQuestionShell: () => view.syncQuestionShell(app),
    querySelector(selector) {
      if (selector === '.kikx-inbox')
        return screen;

      return screen.querySelector(selector);
    },
    querySelectorAll(selector) {
      return screen.querySelectorAll(selector);
    },
  };

  let list = buildInboxList(app, {});
  screen.appendChild(list);

  let [ firstCard, secondCard ] = cardsOf(screen);
  inputOf(secondCard).value = 'this must survive';

  let result = await view.submitQuestionAnswer(app, 'q_1', 'Use PostgreSQL');

  assert.equal(result.ok, true);
  assert.deepEqual(posted, [ '/api/v1/questions/q_1/answer' ]);

  assert.equal(renders, 0, 'no full shell rebuild — that is what used to wipe the drafts');
  assert.equal(questionsState.questions.length, 1, 'the answered question left the model immediately');

  let remaining = cardsOf(screen);
  assert.equal(remaining.length, 1);
  assert.equal(inputOf(remaining[0]).value, 'this must survive', 'the other draft is untouched');
});

test('a read repaints only the badge, never the list', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let screen = document.createElement('div');
  screen.className = 'kikx-inbox';

  let badge = document.createElement('span');
  badge.className = 'kikx-sidebar__inbox-badge';
  badge.textContent = '2';
  let entry = document.createElement('button');
  entry.className = 'kikx-sidebar__inbox';
  entry.appendChild(badge);
  screen.appendChild(entry);

  let questionsState = createQuestionsState();
  questionsState.questions = batch();

  let renders = 0;
  let app = {
    _state: { questionsState },
    ownerDocument: document,
    _postJSON: async () => ({ data: { question: { id: 'q_1', readAt: 5000 } } }),
    _requestRender: () => { renders += 1; },
    _syncQuestionShell: () => view.syncQuestionShell(app),
    querySelector(selector) {
      if (selector === '.kikx-inbox')
        return screen;

      return screen.querySelector(selector);
    },
    querySelectorAll(selector) {
      return screen.querySelectorAll(selector);
    },
  };

  // An open Inbox always renders its list; without it the sync correctly
  // declines to repaint and the caller falls back to a rebuild.
  screen.appendChild(buildInboxList(app, {}));
  let [ firstCard ] = cardsOf(screen);
  inputOf(firstCard).value = 'typed and unsent';

  await view.markQuestionRead(app, 'q_1');

  assert.equal(renders, 0, 'a read must not rebuild the shell');
  assert.equal(questionsState.questions.find((entry) => entry.id === 'q_1').readAt, 5000);
  assert.equal(badge.textContent, '1', 'the badge drops the read question without a refetch');
  assert.equal(inputOf(cardsOf(screen)[0]).value, 'typed and unsent', 'the draft survives a read');
});

test('dropping the badge to zero does not force a rebuild', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let screen = document.createElement('div');
  screen.className = 'kikx-inbox';

  let badge = document.createElement('span');
  badge.className = 'kikx-sidebar__inbox-badge';
  badge.textContent = '1';
  let entry = document.createElement('button');
  entry.className = 'kikx-sidebar__inbox';
  entry.appendChild(badge);
  screen.appendChild(entry);

  // One unread question, so reading it takes the count to zero — the exact
  // shape change that used to report `false` and trigger a full rebuild.
  let questionsState = createQuestionsState();
  questionsState.questions = [ question({ id: 'q_1' }) ];

  let renders = 0;
  let app = {
    _state: { questionsState },
    ownerDocument: document,
    _postJSON: async () => ({ data: { question: { id: 'q_1', readAt: 6000 } } }),
    _requestRender: () => { renders += 1; },
    _syncQuestionShell: () => view.syncQuestionShell(app),
    querySelector(selector) {
      if (selector === '.kikx-inbox')
        return screen;

      return screen.querySelector(selector);
    },
    querySelectorAll(selector) {
      return screen.querySelectorAll(selector);
    },
  };

  screen.appendChild(buildInboxList(app, {}));
  inputOf(cardsOf(screen)[0]).value = 'still typing this';

  await view.markQuestionRead(app, 'q_1');

  assert.equal(renders, 0, 'N -> 0 unread must be handled in place, not by rebuilding');
  assert.equal(
    screen.querySelector('.kikx-sidebar__inbox-badge'),
    null,
    'the badge node is removed',
  );
  assert.equal(entry.getAttribute('aria-label'), 'Inbox');
  assert.equal(inputOf(cardsOf(screen)[0]).value, 'still typing this', 'the draft survives');
});

test('the badge is added in place when a question arrives unread', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let screen = document.createElement('div');
  screen.className = 'kikx-inbox';

  let entry = document.createElement('button');
  entry.className = 'kikx-sidebar__inbox';
  screen.appendChild(entry);

  let questionsState = createQuestionsState();
  questionsState.questions = [ question({ id: 'q_1' }) ];

  let app = {
    _state: { questionsState },
    ownerDocument: document,
    querySelector(selector) {
      if (selector === '.kikx-inbox')
        return screen;

      return screen.querySelector(selector);
    },
    querySelectorAll(selector) {
      return screen.querySelectorAll(selector);
    },
  };

  // The badge itself is created in place. `syncQuestionShell` still reports
  // `false` here because no Inbox list is rendered, and declining to claim the
  // repaint is the honest answer — the caller decides what to do next.
  view.syncQuestionShell(app);

  let badge = screen.querySelector('.kikx-sidebar__inbox-badge');
  assert.ok(badge, 'the badge node was created in place, with no rebuild needed');
  assert.equal(badge.textContent, '1');
  assert.equal(entry.getAttribute('aria-label'), 'Inbox, 1 unread questions');
});
