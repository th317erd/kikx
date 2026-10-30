'use strict';

// The owner asked for ONE response experience across the Inbox and the session:
// "I want the response experience to be the same for the user regardless of if
// it is the inbox or the session." Their wording for a human answer is exactly
// "You replied", replacing "Your answer".
//
// Two things can go wrong here, and both have:
//
//   1. The surfaces disagree. They used to be two renderers, and two renderers
//      drift -- that is the entire reason the Inbox now mounts a real
//      `kikx-question-frame`.
//   2. The label over-reaches. A receipt reading "You replied: declined to say"
//      for an answer the AGENT supplied is a lie about who spoke. The label must
//      attach to human provenance only.
//
// So this spec drives both surfaces with the same question and compares the
// rendered label text, then proves the label does NOT appear where the user did
// not speak.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { USER_ANSWER_LABEL, buildAnswerReceipt, RECEIPT_CLASSES } =
  await import('../../src/client/components/kikx-answer-receipt.mjs');
const { renderInboxQuestionRow, KikxQuestionFrame } =
  await import('../../src/client/components/kikx-question-frame.mjs');

// --- helpers ---------------------------------------------------------------

function walk(node, out = []) {
  for (let child of node?.childNodes || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function byClass(root, className) {
  return walk(root).filter((node) =>
    String(node.className || '').split(/\s+/).includes(className));
}

function textOf(node) {
  if (!node)
    return '';
  if (node.nodeType === 3)
    return String(node.textContent ?? node.data ?? '');
  return (node.childNodes || []).map(textOf).join('');
}

function question(overrides = {}) {
  return {
    id: 'q_1',
    groupID: 'grp_1',
    index: 1,
    status: 'answered',
    mode: 'wait',
    sessionID: 'ses_1',
    agentID: 'agent-1',
    text: 'Which database should we use?',
    priority: 'normal',
    askedAt: 1000,
    ...overrides,
  };
}

function inboxRow(overrides) {
  return renderInboxQuestionRow({}, question(overrides));
}

function threadFrame(overrides) {
  let el = document.createElement('kikx-question-frame');
  el.updateFrame(
    { id: 'f_1', type: 'Question', content: { question: question(overrides) } },
    {},
    {},
  );
  return el;
}

// --- the owner's wording ---------------------------------------------------

test('the shared constant IS the owner\'s wording', () => {
  assert.equal(USER_ANSWER_LABEL, 'You replied',
    'the owner asked for "You replied"; "Your answer" was the wording it replaced');
});

test('Inbox and session render the SAME human-answer label', () => {
  let overrides = { answer: 'Postgres.', answerSource: 'user' };

  let label = textOf(byClass(inboxRow(overrides), 'kikx-question-card__receipt-label')[0]).trim();
  let thread = textOf(byClass(threadFrame(overrides), 'kikx-question-frame__answer-label')[0]).trim();

  assert.equal(label, 'You replied', 'the Inbox row uses the owner\'s wording');
  assert.equal(thread, 'You replied', 'the session frame uses the same wording');
  assert.equal(label, thread, 'the two surfaces cannot disagree about who spoke');
});

test('the answer text is still shown on both surfaces, and still green', () => {
  let overrides = { answer: 'Postgres, not MySQL.', answerSource: 'user' };

  let rowText = textOf(byClass(inboxRow(overrides), 'kikx-question-card__receipt-text')[0]).trim();
  let threadText = textOf(byClass(threadFrame(overrides), 'kikx-question-frame__answer-text')[0]).trim();

  assert.equal(rowText, 'Postgres, not MySQL.');
  assert.equal(threadText, 'Postgres, not MySQL.');

  // The colour parity itself is pinned in answer-green-spec.mjs, which reads the
  // stylesheet; this only protects the class names it addresses.
  assert.equal(byClass(inboxRow(overrides), 'kikx-question-card__receipt-text').length, 1);
  assert.equal(byClass(threadFrame(overrides), 'kikx-question-frame__answer-text').length, 1);
});

// --- the label must not over-reach ----------------------------------------

test('an agent-supplied answer is never labelled "You replied"', () => {
  let overrides = { answer: 'declined to say', answerSource: 'agent' };

  let label = textOf(byClass(inboxRow(overrides), 'kikx-question-card__receipt-label')[0]).trim();

  assert.notEqual(label, 'You replied', 'the user did not reply to this one');
  assert.match(label, /agent/i, 'and it says who actually did');
});

test('a delivered default is never labelled "You replied"', () => {
  let overrides = { answer: 'declined to say', answerSource: 'default' };

  let rowLabel = textOf(byClass(inboxRow(overrides), 'kikx-question-card__receipt-label')[0]).trim();
  let threadLabel = textOf(byClass(threadFrame(overrides), 'kikx-question-frame__answer-label')[0]).trim();

  for (let [ surface, label ] of [ [ 'Inbox', rowLabel ], [ 'session', threadLabel ] ]) {
    assert.notEqual(label, 'You replied', `${surface}: a default answer is the agent's words`);
    assert.match(label, /Default answer/i, `${surface}: and it is named as one`);
  }
});

// --- one answer, two ways to paint it -------------------------------------

// There are two independent paths that put a human answer on screen, and they
// see DIFFERENT information:
//
//   * `_showSent()` runs the instant the POST resolves. It has the text the
//     person typed and nothing else -- no question document, so no
//     `answerSource`.
//   * `buildAnswerReceipt()` runs on every re-render, including the
//     `question.updated` event that can arrive BEFORE that POST resolves. It has
//     the document, provenance included.
//
// If the label is inferred from provenance, those two paths disagree about the
// same reply, and which one the user sees is decided by a socket race. That is
// exactly what happened: labelling an absent `answerSource` as "anonymous" made
// a socket-first reply lose its label (measured at `7a4bf170` as
// `one "You replied" label, not two: 0 !== 1` in question-frame-spec.mjs).
//
// So: same reply, both paths, same label. This is a guard rather than a
// discriminator -- it also passes at `b9761322`, where both paths happened to
// agree by accident. The discriminating evidence for this failure is the
// question-frame-spec test above.
test('the send path and the re-render path label the same reply identically', () => {
  let typedByThePerson = 'Postgres, not MySQL.';

  // The re-render path: full document, provenance known.
  let fromReRender = buildAnswerReceipt(
    document,
    question({ answer: typedByThePerson, answerSource: 'user' }),
    RECEIPT_CLASSES.frame,
  );

  // The send path: text only, no document. `_showSent` builds the same block with
  // no label option at all.
  let fromReRenderLabel = textOf(byClass(fromReRender, 'kikx-question-frame__answer-label')[0]).trim();

  let sendPath = document.createElement('div');
  sendPath.appendChild(buildAnswerReceipt(
    document,
    { answer: typedByThePerson, answerSource: null },
    RECEIPT_CLASSES.frame,
  ));
  let fromSendLabel = textOf(byClass(sendPath, 'kikx-question-frame__answer-label')[0]).trim();

  assert.equal(fromSendLabel, 'You replied',
    'the path that only knows the typed words still knows a person typed them');
  assert.equal(fromSendLabel, fromReRenderLabel,
    'a socket race must not change what the receipt calls the same reply');
});
