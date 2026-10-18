'use strict';

// Inbox list + question card rendering (plan §6.2, §6.3, §8).
//
// These modules import the AEOR element DSL through aeor-ui.mjs, whose
// /vendor/... imports are browser-only. Redirect them to local stand-ins first,
// exactly as the other DOM specs do.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  buildInboxList,
  inboxEmptyState,
  inboxHeader,
} = await import('../../src/client/components/kikx-inbox-list.mjs');
const { renderQuestionCard, bindAnswerForm } = await import('../../src/client/components/kikx-question-card.mjs');

function question(overrides = {}) {
  return {
    id: 'q_1',
    status: 'open',
    mode: 'wait',
    text: 'Which database should we use?',
    priority: 'normal',
    askedAt: Date.now() - 60_000,
    sessionID: 'ses_1',
    agentID: 'agent-1',
    ...overrides,
  };
}

function appWith(questions, extra = {}) {
  return {
    _state: {
      questionsState: {
        questions,
        counts: { open: questions.length },
        loaded: true,
        ...extra,
      },
    },
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

function textOf(node, className) {
  let match = byClass(node, className)[0];
  return match ? String(match.textContent ?? '').trim() : null;
}

test('buildInboxList renders the empty state when there are no questions', () => {
  let node = buildInboxList(appWith([]));
  assert.ok(node, 'a list node is returned');
  assert.equal(byClass(node, 'kikx-inbox-list').length, 0, 'no list shell for zero questions');
  assert.ok(byClass(node, 'kikx-inbox-empty').length >= 1);
  assert.match(String(node.textContent ?? ''), /Nothing waiting on you/);
});

test('buildInboxList does not throw when the questions slice is missing', () => {
  // S1: a missing slice is a normal pre-fetch state, not an error.
  let bare = buildInboxList({ _state: {} });
  assert.ok(byClass(bare, 'kikx-inbox-empty').length >= 1);

  let noState = buildInboxList({});
  assert.ok(byClass(noState, 'kikx-inbox-empty').length >= 1);
});

test('buildInboxList renders one card per question, oldest group first', () => {
  let node = buildInboxList(appWith([
    question({ id: 'q_new', text: 'Newer?', askedAt: 2_000 }),
    question({ id: 'q_old', text: 'Older?', askedAt: 1_000 }),
  ]));

  let cards = byClass(node, 'kikx-question-card');
  assert.equal(cards.length, 2, 'one card per question');
  assert.deepEqual(
    cards.map((card) => card.getAttribute('data-question-id')),
    [ 'q_old', 'q_new' ],
    'oldest first',
  );
});

test('a multi-question group renders one heading; a single question renders none', () => {
  let grouped = buildInboxList(appWith([
    question({ id: 'q_1', groupID: 'grp_1', index: 1, askedAt: 1_000 }),
    question({ id: 'q_2', groupID: 'grp_1', index: 2, askedAt: 1_000 }),
  ]));

  let headings = byClass(grouped, 'kikx-inbox-list__heading');
  assert.equal(headings.length, 1, 'the batch is one flow, so one heading');
  assert.match(String(headings[0].textContent ?? ''), /Waiting on you · 2 questions/);

  let single = buildInboxList(appWith([ question({ id: 'q_solo' }) ]));
  assert.equal(byClass(single, 'kikx-inbox-list__heading').length, 0,
    'one question needs no batch heading');
});

test('a card shows the question text, asking agent and an inline answer input', () => {
  let node = renderQuestionCard({}, question({ text: 'Ship it?', agentID: 'zav' }));
  assert.ok(node, 'a card node is returned');

  assert.equal(textOf(node, 'kikx-question-card__text'), 'Ship it?');
  // The card shows "asking agent · session" verbatim (plan §6.2): it has no
  // session/agent lookup and must not invent a prettified label.
  let meta = textOf(node, 'kikx-question-card__agent');
  assert.match(meta, /^zav/, `agent label should name the asker, got ${JSON.stringify(meta)}`);
  assert.match(meta, /ses_1/, 'and the session it was asked in');
  assert.equal(byClass(node, 'kikx-question-card__input').length, 1, 'a free-form input');
  assert.equal(byClass(node, 'kikx-question-card__submit').length, 1);
});

test('the card offers no options, toggles or quick-picks ([D-4])', () => {
  // Free-form text only: in-app answer widgets underperformed and nuance is the
  // point, so reintroducing a picker would be a behaviour the owner rejected.
  let node = renderQuestionCard({}, question());

  assert.equal(walk(node, (n) => String(n.tagName || '').toLowerCase() === 'select').length, 0,
    'no dropdown');
  assert.equal(walk(node, (n) => String(n.tagName || '').toLowerCase() === 'button'
    && /^(yes|no|approve|reject|ok|cancel)$/i.test(String(n.textContent || '').trim())).length, 0,
  'no yes/no quick-pick buttons');
  assert.equal(walk(node, (n) => String(n.tagName || '').toLowerCase() === 'input'
    && [ 'checkbox', 'radio' ].includes(String(n.getAttribute?.('type') || ''))).length, 0,
  'no toggles');
});

test('submitting a non-empty answer calls onSubmit with trimmed text', () => {
  let seen = [];
  let node = renderQuestionCard({}, question({ id: 'q_submit' }));
  bindAnswerForm(node, { onSubmit: (questionID, text) => { seen.push([ questionID, text ]); } });

  let input = byClass(node, 'kikx-question-card__input')[0];
  input.value = '   use postgres   ';

  // The card binds the form's `submit` event, not a button click.
  let form = byClass(node, 'kikx-question-card__answer')[0];
  form.dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));

  assert.deepEqual(seen, [ [ 'q_submit', 'use postgres' ] ]);
});

test('an empty or whitespace-only answer never calls onSubmit', () => {
  let calls = 0;
  let node = renderQuestionCard({}, question());
  bindAnswerForm(node, { onSubmit: () => { calls += 1; } });

  let input = byClass(node, 'kikx-question-card__input')[0];
  let form = byClass(node, 'kikx-question-card__answer')[0];

  for (let value of [ '', '   ', '\n\t ' ]) {
    input.value = value;
    form.dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));
  }

  assert.equal(calls, 0, 'a blank answer must not be posted');
});

test('a terminal question does not offer an answer box', () => {
  let node = renderQuestionCard({}, question({ status: 'answered' }));
  assert.ok(node, 'a closed question still renders');

  // The card hides the form for terminal rows; an offered box that would 409 is
  // worse than showing the row read-only.
  assert.equal(byClass(node, 'kikx-question-card__input').length, 0,
    'terminal rows must not present a submittable answer control');
  assert.equal(byClass(node, 'kikx-question-card__answer').length, 0);
  assert.match(String(node.textContent ?? ''), /answered/);
});

test('an invalid question degrades to null instead of throwing', () => {
  assert.equal(renderQuestionCard({}, { id: '', text: '' }), null);
  assert.equal(renderQuestionCard({}, null), null);
});

test('contextRefs render as labels carrying their identity', () => {
  let node = renderQuestionCard({}, question({
    contextRefs: [
      { type: 'frame', id: 'f_1', label: 'the failing test' },
      { type: 'question', id: 'q_9' },
    ],
  }));

  let refs = byClass(node, 'kikx-question-card__ref');
  assert.equal(refs.length, 2);
  assert.equal(refs[0].getAttribute('data-ref-type'), 'frame');
  assert.equal(refs[0].getAttribute('data-ref-id'), 'f_1');
  assert.equal(refs[1].getAttribute('data-ref-type'), 'question');
});

test('inboxHeader reports the open count and surfaces load errors', () => {
  let heading = inboxHeader(appWith([ question({ id: 'q_a' }), question({ id: 'q_b' }) ]));
  assert.ok(heading, 'a header node is returned');
  assert.match(String(heading.textContent ?? ''), /Inbox/);
  assert.equal(textOf(heading, 'kikx-inbox-header__count'), '2');

  let failing = inboxHeader(appWith([], { error: 'boom' }));
  assert.equal(textOf(failing, 'kikx-inbox-header__error'), 'boom');
});

test('inboxEmptyState renders the same shape the list falls back to', () => {
  let node = inboxEmptyState(appWith([]));
  assert.ok(byClass(node, 'kikx-inbox-empty').length >= 1);
});
