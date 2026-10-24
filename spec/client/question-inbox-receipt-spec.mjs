'use strict';

// The Inbox row shows WHAT was answered, not just the word "answered".
//
// The complaint behind this spec is a screenshot: an answered question in the
// Inbox rendered "You replied." and nothing else. The thread rendered the answer
// with its provenance; the single place you go to look across all your questions
// did not. So the one surface that exists to answer "what did I say?" was the one
// surface that would not.
//
// The fix shares `buildAnswerReceipt` between the frame and the card, so these
// tests are partly about the receipt appearing and partly about the two surfaces
// staying honest in the same way. The three rules under test are the ones that
// were each a bug once:
//
//   1. A default answer is the AGENT's words. It is never labelled as the
//      user's. (A receipt reading "Your answer: declined to say" is a lie about
//      who spoke.)
//   2. A revision shows BOTH answers, because the agent was already told the
//      default and may have acted on it. Showing only the replacement would hide
//      the correction.
//   3. Provenance is claimed only when it is known. An answer written before
//      `answerSource` existed carries no marker at all, rather than guessing.
//
// There are three separate paths through the builder that can produce a default
// receipt — still-revisable, acknowledged, and superseded — and each has its own
// assertions below. Testing only one of them leaves the other two free to drift,
// which is exactly how the labelling bug survived a green suite once already.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The card reaches `/vendor/aeor-web-components/*` through aeor-ui.mjs, which
// only resolves in the browser. The shared loader aliases those specifiers to
// local stand-ins.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();

const app = { ownerDocument: document };

function question(overrides = {}) {
  return {
    id: 'q_1',
    text: 'Which database should we use?',
    status: 'answered',
    askedAt: 1000,
    ...overrides,
  };
}

test('an answered row shows the answer itself, labelled and marked as the user\'s', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, question({
    answer: 'Postgres, not MySQL.',
    answerSource: 'user',
  }));

  let receipt = card.querySelector('.kikx-question-card__receipt');
  assert.ok(receipt, 'the row renders a receipt instead of a bare status line');

  let text = card.querySelector('.kikx-question-card__receipt-text');
  assert.equal(text.textContent, 'Postgres, not MySQL.',
    'the answer text is what the row must show — the whole point of the change');

  let label = card.querySelector('.kikx-question-card__receipt-label');
  assert.equal(label.textContent, 'Your answer', 'the words are attributed, not anonymous');

  assert.equal(receipt.getAttribute('data-answer-source'), 'user',
    'provenance is published as data so the stylesheet and specs never match on prose');
});

test('the answer text carries the green receipt, and a default does not', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');

  let human = renderQuestionCard(app, question({ answer: 'Postgres.', answerSource: 'user' }));
  let agent = renderQuestionCard(app, question({
    answer: 'declined to say',
    answerSource: 'default',
  }));

  // The colour lives in the stylesheet, so what a spec can assert is the hook the
  // colour hangs off: the green receipt is the one with no `default` marker, and
  // it is a different element from the grey status line it replaced.
  let humanReceipt = human.querySelector('.kikx-question-card__receipt');
  let agentReceipt = agent.querySelector('.kikx-question-card__receipt');

  assert.equal(humanReceipt.getAttribute('data-answer-source'), 'user');
  assert.equal(agentReceipt.getAttribute('data-answer-source'), 'default');

  assert.notEqual(
    agentReceipt.getAttribute('data-answer-source'),
    humanReceipt.getAttribute('data-answer-source'),
    'a default must not be styled as though the user wrote it',
  );
});

test('a still-revisable default answer is never labelled as the user\'s words', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, question({
    answer: 'declined to say',
    answerSource: 'default',
  }));

  let label = card.querySelector('.kikx-question-card__receipt-label');
  assert.notEqual(label.textContent, 'Your answer',
    'this is the lie the receipt exists to prevent');
  assert.match(label.textContent, /Default/);
});

test('an acknowledged default is still labelled a default', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  // Confirming says the words were right; it does not say the person wrote them.
  // This is a separate branch from the revisable case, and it carries its own
  // label — so it gets its own assertion.
  let card = renderQuestionCard(app, question({
    answer: 'declined to say',
    answerSource: 'default',
    acknowledgedAt: 8000,
  }));

  let label = card.querySelector('.kikx-question-card__receipt-label');
  assert.notEqual(label.textContent, 'Your answer',
    'a confirmed default is still the agent\'s words, not the user\'s');
  assert.match(label.textContent, /Default/);

  assert.equal(
    card.querySelector('.kikx-question-card__receipt').getAttribute('data-answer-source'),
    'default',
  );

  let note = card.querySelector('.kikx-question-card__receipt-note');
  assert.match(note.textContent, /confirmed/, 'the receipt says the person agreed with it');
  assert.match(note.textContent, /notified/, 'and that confirming woke nobody');
});

test('a revised answer shows both the default and the correction, oldest first', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, question({
    answer: 'Use Postgres.',
    answerSource: 'user',
    supersededDefaultAnswer: 'declined to say',
    revisedAt: 9000,
  }));

  let blocks = [ ...card.querySelectorAll('.kikx-question-card__receipt') ];
  assert.equal(blocks.length, 2, 'both answers are shown; the correction never erases the default');

  assert.equal(blocks[0].getAttribute('data-answer-source'), 'default',
    'the default comes first because that is what the agent was told first');
  assert.equal(
    blocks[0].querySelector('.kikx-question-card__receipt-text').textContent,
    'declined to say',
  );
  assert.match(
    blocks[0].querySelector('.kikx-question-card__receipt-label').textContent,
    /Default/,
    'the superseded answer is labelled as the agent\'s fallback too',
  );

  assert.equal(blocks[1].getAttribute('data-answer-source'), 'user');
  assert.equal(
    blocks[1].querySelector('.kikx-question-card__receipt-text').textContent,
    'Use Postgres.',
  );
});

test('a note never promises a box the row does not render', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');

  // A closed row has no answer form, so "you can replace it below" would point at
  // nothing. The frame keeps that promise because its default really is still
  // revisable; the Inbox row must not copy the sentence. Both notes that can make
  // the promise are covered.
  let live = renderQuestionCard(app, question({
    answer: 'declined to say',
    answerSource: 'default',
    closedAt: 5000,
    settleAfter: 60000,
  }));

  assert.equal(live.querySelector('.kikx-question-card__input'), null,
    'precondition: this row really has no box');

  let liveNote = live.querySelector('.kikx-question-card__receipt-note');
  assert.ok(liveNote, 'a default explains itself');
  assert.doesNotMatch(liveNote.textContent, /below/,
    'the note must not send the reader looking for a control that is not rendered');
  assert.match(liveNote.textContent, /applied/);

  let acknowledged = renderQuestionCard(app, question({
    answer: 'declined to say',
    answerSource: 'default',
    acknowledgedAt: 8000,
    closedAt: 5000,
    settleAfter: 60000,
  }));

  assert.doesNotMatch(
    acknowledged.querySelector('.kikx-question-card__receipt-note').textContent,
    /below/,
    'the acknowledged note makes the same promise and needs the same guard',
  );
});

test('an answer of unknown provenance claims nothing about who said it', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  // `answerSource` did not always exist. Guessing 'user' here would offer a
  // correction path on someone else's answer.
  let card = renderQuestionCard(app, question({ answer: 'Postgres.' }));

  let receipt = card.querySelector('.kikx-question-card__receipt');
  assert.ok(receipt, 'the words still show');
  assert.equal(receipt.getAttribute('data-answer-source'), null,
    'no marker beats a wrong marker');
});

test('a terminal row with no answer at all still says what happened', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  // The receipt is null here — a question can close without an answer (dismissed,
  // or withdrawn by the asker). That is not a failure; it wants a status line.
  let answered = renderQuestionCard(app, question({ status: 'answered' }));
  assert.equal(answered.querySelector('.kikx-question-card__receipt'), null);
  assert.equal(answered.querySelector('.kikx-question-card__closed').textContent, 'Closed: answered.');

  let dismissed = renderQuestionCard(app, question({ status: 'dismissed' }));
  assert.equal(dismissed.querySelector('.kikx-question-card__receipt'), null);
  assert.equal(dismissed.querySelector('.kikx-question-card__closed').textContent, 'Closed: dismissed.');
});

test('a dismissed row keeps its own wording instead of borrowing the receipt', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  // A dismissal this tab just performed explains itself and says nobody was
  // woken. It carries no answer, so no receipt may steal the row.
  let card = renderQuestionCard(app, question({
    status: 'dismissed',
    closedAt: 5000,
    settleAfter: 60000,
  }));

  assert.equal(card.querySelector('.kikx-question-card__receipt'), null);
  let note = card.querySelector('.kikx-question-card__closed');
  assert.match(note.textContent, /chose not to respond/);
  assert.match(note.textContent, /not woken/);
});

test('an open row still renders the form, not a receipt', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, question({ status: 'open' }));

  assert.ok(card.querySelector('.kikx-question-card__input'), 'an open row offers a box');
  assert.equal(card.querySelector('.kikx-question-card__receipt'), null,
    'a question nobody has answered has nothing to report');
});

test('answering a row records WHO wrote the answer, not just the words', async () => {
  // A real-browser run caught this and the render specs could not: they build
  // the question object themselves, so they never exercise the path that turns
  // an OPEN row into a settled one. `settleQuestion` spread the old row and
  // overwrote answer/status/closedAt/settleAfter but never `answerSource`, so a
  // human answer inherited the open question's `null` and the receipt had no
  // source marker to style or assert — an answered row that would not say who
  // answered it.
  const { applyLocalAnswer } = await import('../../src/client/state/questions-local-state.mjs');

  let state = {
    questions: [ { id: 'q_1', status: 'open', text: 'Which database?', askedAt: 1000 } ],
    counts: {},
  };

  applyLocalAnswer(state, 'q_1', { answer: 'Postgres.', closedAt: 5000, settleAfter: 60000 });

  let row = state.questions.find((question) => question.id === 'q_1');
  assert.equal(row.status, 'answered');
  assert.equal(row.answer, 'Postgres.');
  assert.equal(row.answerSource, 'user',
    'the row must know a person wrote this, or the receipt cannot say so');

  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, row);
  assert.equal(
    card.querySelector('.kikx-question-card__receipt').getAttribute('data-answer-source'),
    'user',
    'and end to end: the settled row renders a receipt marked as the user\u2019s own words',
  );
});

test('settling a row does not overwrite an answer\u2019s provenance by omission', async () => {
  // A dismissal settles a row without answering it. It must not blank out (or
  // relabel) the source of an answer that is already there.
  const { settleQuestion } = await import('../../src/client/state/questions-state.mjs');

  let rows = [ {
    id: 'q_1',
    status: 'answered',
    text: 'Which database?',
    askedAt: 1000,
    answer: 'Postgres.',
    answerSource: 'user',
  } ];

  let settled = settleQuestion(rows, 'q_1', { status: 'dismissed', closedAt: 5000, settleAfter: 60000 });
  assert.equal(settled[0].answerSource, 'user',
    'a settle that names no source leaves the recorded one alone');
});
