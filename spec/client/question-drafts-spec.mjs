'use strict';

// Drafts that outlive the DOM node they were typed into.
//
// The reported bug had two layers. The first — answering one question wiped
// *both* cards — is covered by `question-draft-preservation-spec.mjs`, because
// the Inbox no longer rebuilds its list on a sibling answer. The second layer is
// what this file defends: the Inbox is still rebuilt from scratch on paths the
// question flow does not control (session switch, an unrelated runtime event,
// the empty <-> non-empty fallback). The textarea's value dies with its node, so
// a store outside the DOM is the only thing that keeps typed text alive.
//
// The user's requirement, verbatim: "do not mess with OTHER questions that I
// already have a typed-up unsubmitted response written into."

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  createDraftStore,
  getAnswerDraft,
  setAnswerDraft,
  clearAnswerDraft,
  pruneAnswerDrafts,
  MAX_ANSWER_DRAFTS,
} = await import('../../src/client/state/question-drafts.mjs');

const { renderQuestionCard, bindAnswerForm } = await import('../../src/client/components/kikx-question-card.mjs');

const INPUT = 'kikx-question-card__input';
const CARD = 'kikx-question-card';

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

function inputOf(card) {
  return card.querySelector(`.${INPUT}`);
}

// Renders a card the way the real list does, then binds it with a draft store —
// i.e. exactly the path `buildInboxList`/`syncInboxList` take.
function renderBound(app, q, drafts) {
  let card = renderQuestionCard(app, q, { now: 5000 });
  bindAnswerForm(card, { drafts });
  return card;
}

test('a draft set on one question is readable on its own', () => {
  let store = createDraftStore();
  setAnswerDraft(store, 'q_1', 'PostgreSQL, because of the JSON columns');

  assert.equal(getAnswerDraft(store, 'q_1'), 'PostgreSQL, because of the JSON columns');
  assert.equal(getAnswerDraft(store, 'q_2'), '', 'an untouched question has no draft');
});

test('writing one draft never disturbs another', () => {
  let store = createDraftStore();
  setAnswerDraft(store, 'q_1', 'first answer');
  setAnswerDraft(store, 'q_2', 'second answer');

  // This is the user's explicit requirement: answering or typing into question
  // one must not touch the queued response on question two.
  assert.equal(getAnswerDraft(store, 'q_1'), 'first answer');
  assert.equal(getAnswerDraft(store, 'q_2'), 'second answer');

  clearAnswerDraft(store, 'q_1');
  assert.equal(getAnswerDraft(store, 'q_1'), '');
  assert.equal(getAnswerDraft(store, 'q_2'), 'second answer', 'clearing q_1 leaves q_2 alone');
});

test('an empty string clears the draft instead of storing empty text', () => {
  let store = createDraftStore();
  setAnswerDraft(store, 'q_1', 'drafting');
  setAnswerDraft(store, 'q_1', '');

  assert.equal(getAnswerDraft(store, 'q_1'), '');
  assert.equal(store.size, 0, 'a cleared box must not occupy a slot in the bounded store');
});

test('the store is bounded and evicts the least recently typed draft', () => {
  let store = createDraftStore();
  for (let index = 0; index < MAX_ANSWER_DRAFTS; index++)
    setAnswerDraft(store, `q_${index}`, `draft ${index}`);

  assert.equal(store.size, MAX_ANSWER_DRAFTS);

  // Re-typing into the oldest question makes it the newest, so the eviction
  // that follows must not take it.
  setAnswerDraft(store, 'q_0', 'draft 0 revisited');
  setAnswerDraft(store, 'q_overflow', 'newest');

  assert.equal(store.size, MAX_ANSWER_DRAFTS, 'the bound holds');
  assert.equal(getAnswerDraft(store, 'q_0'), 'draft 0 revisited', 'recently typed text survives');
  assert.equal(getAnswerDraft(store, 'q_overflow'), 'newest');
  assert.equal(getAnswerDraft(store, 'q_1'), '', 'the least recently typed draft was evicted');
});

test('pruning drops drafts for questions that are no longer open', () => {
  let store = createDraftStore();
  setAnswerDraft(store, 'q_1', 'still open, keep me');
  setAnswerDraft(store, 'q_2', 'answered elsewhere, drop me');

  pruneAnswerDrafts(store, new Set([ 'q_1' ]));

  assert.equal(getAnswerDraft(store, 'q_1'), 'still open, keep me');
  assert.equal(getAnswerDraft(store, 'q_2'), '', 'a question that left the open set takes its draft with it');
});

test('a card created after a rebuild restores the stored draft', () => {
  let store = createDraftStore();
  let app = { ownerDocument: document };

  // First paint: the user types into the box. The binder saves every keystroke,
  // so writing to the store is what the 'input' listener does.
  let first = renderBound(app, question({ id: 'q_1' }), store);
  inputOf(first).value = 'PostgreSQL';
  setAnswerDraft(store, 'q_1', inputOf(first).value);

  // A full rebuild throws that node away and renders a brand-new one.
  let second = renderBound(app, question({ id: 'q_1' }), store);

  assert.notEqual(second, first, 'the rebuild really produced a different node');
  assert.equal(
    inputOf(second).value,
    'PostgreSQL',
    'the typed-but-unsent answer survives a full rebuild',
  );
});

test('a rebuild restores each card\'s own draft, not a shared one', () => {
  let store = createDraftStore();
  let app = { ownerDocument: document };

  let firstPaint = [
    renderBound(app, question({ id: 'q_1', index: 1, groupID: 'g' }), store),
    renderBound(app, question({ id: 'q_2', index: 2, groupID: 'g' }), store),
  ];

  inputOf(firstPaint[0]).value = 'answer for one';
  inputOf(firstPaint[1]).value = 'answer for two';
  setAnswerDraft(store, 'q_1', 'answer for one');
  setAnswerDraft(store, 'q_2', 'answer for two');

  let secondPaint = [
    renderBound(app, question({ id: 'q_1', index: 1, groupID: 'g' }), store),
    renderBound(app, question({ id: 'q_2', index: 2, groupID: 'g' }), store),
  ];

  assert.equal(inputOf(secondPaint[0]).value, 'answer for one');
  assert.equal(inputOf(secondPaint[1]).value, 'answer for two');
});

test('a card with no stored draft renders an empty box', () => {
  let store = createDraftStore();
  let app = { ownerDocument: document };

  let card = renderBound(app, question({ id: 'q_fresh' }), store);

  // `?? ''` because mini-dom's elements carry no default `value` the way a real
  // textarea carries `''`; the invariant under test is "nothing was written
  // into this box", which is exactly what an untouched node means in both DOMs.
  assert.equal(
    inputOf(card).value ?? '',
    '',
    'a newly asked question must not inherit someone else\'s text',
  );
});

test('a terminal card renders no answer box at all, so no draft is restored', () => {
  let store = createDraftStore();
  let app = { ownerDocument: document };
  setAnswerDraft(store, 'q_1', 'text typed before it was answered elsewhere');

  let card = renderBound(app, question({ id: 'q_1', status: 'answered' }), store);

  assert.ok(!inputOf(card), 'an answered row is read-only, so there is no box to restore into');
  assert.ok(String(card.className).includes(CARD), 'the card itself still renders, just without a box');
});

test('question draft mutations are exact and contained to the question key', () => {
  let store = createDraftStore({ sessionID: 'ses_1' });
  setAnswerDraft(store, 'q_1', 'answer one');
  setAnswerDraft(store, 'q_2', 'answer two');

  assert.deepEqual(store.mutations.entries().map((entry) => ({
    scope: entry.scope,
    owner: entry.owner,
    key: entry.key,
    previous: entry.previous,
    next: entry.next,
    operation: entry.operation,
    revision: entry.revision,
  })), [
    { scope: 'question-drafts', owner: 'ses_1', key: 'q_1', previous: undefined, next: 'answer one', operation: 'set', revision: 1 },
    { scope: 'question-drafts', owner: 'ses_1', key: 'q_2', previous: undefined, next: 'answer two', operation: 'set', revision: 2 },
  ]);
  assert.equal(getAnswerDraft(store, 'q_1'), 'answer one');
  assert.equal(getAnswerDraft(store, 'q_2'), 'answer two');
});
