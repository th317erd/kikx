'use strict';

// The `Question` frame payload the server actually writes.
//
// Why this file exists: question-frame-spec.mjs builds its fixtures with
// `{ question: { id, ... } }`, a shape no server code ever emits. The real
// emitter (ask-user-tool.mjs `emitQuestionFrames`) writes `{ questionID, ... }`
// at the top level of `content`. Because the client normalizer required `id`,
// every inline question frame in a live session resolved to null and rendered
// the "Question unavailable." fallback: no question text, no answer box, no
// Submit. The spec suite was green the whole time because it never fed the
// component the payload the product produces.
//
// So this spec's fixture is a byte-for-byte copy of a frame fetched from the
// running dev server, not a shape invented by a test author.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { KikxQuestionFrame } = await import('../../src/client/components/kikx-question-frame.mjs');
const { normalizeQuestionSummary } = await import('../../src/client/state/questions-state.mjs');

// Verbatim `content` of a Question frame from
// `GET /api/v1/sessions/<id>/frames` on the dev server, 2026-10-20.
const LIVE_FRAME_CONTENT = {
  questionID: '52d200a4-3eec-44c6-aa31-0414e185f50f',
  groupID: 'ac49aff7-a73c-492f-a8e2-e61c63adbab4',
  index: 1,
  text: 'Does `~/.bot-common/startup.md:50` cover Kikx `ask-user`, or only '
    + "Claude Code's blocking multiple-choice `AskUserQuestion`?",
  priority: 'high',
  mode: 'wait',
  status: 'open',
  contextRefs: [
    { type: 'file', id: '/home/wyatt/.bot-common/startup.md', label: 'startup.md line 50', sessionID: null, frameID: null, path: null },
  ],
  askedAt: 1792468917954,
};

function nodes(node, out = []) {
  for (let child of node?.childNodes || []) {
    out.push(child);
    nodes(child, out);
  }
  return out;
}

function byClass(node, className) {
  return nodes(node).filter((child) => {
    let cls = typeof child.className === 'string' ? child.className : '';
    return cls.split(/\s+/).includes(className);
  });
}

function textOf(node) {
  if (!node)
    return '';
  if (node.nodeType === 3)
    return String(node.textContent ?? node.data ?? '');
  return (node.childNodes || []).map(textOf).join('');
}

function mount(frame, appState = {}) {
  let el = document.createElement('kikx-question-frame');
  assert.ok(el instanceof KikxQuestionFrame);
  el.updateFrame(frame, appState);
  return el;
}

// --- the normalizer --------------------------------------------------------

test('a live Question frame payload normalizes instead of returning null', () => {
  let question = normalizeQuestionSummary(LIVE_FRAME_CONTENT);

  assert.ok(question, 'the payload the server actually writes must not be rejected');
  assert.equal(question.id, LIVE_FRAME_CONTENT.questionID);
  assert.equal(question.groupID, LIVE_FRAME_CONTENT.groupID);
  assert.equal(question.priority, 'high');
  assert.equal(question.status, 'open');
  assert.equal(question.contextRefs.length, 1, 'context refs survive normalization');
});

test('the canonical id still wins when both keys are present', () => {
  // New frames carry both. They agree today, but if they ever disagree the
  // explicit `id` is the row key and must not be shadowed by `questionID`.
  let question = normalizeQuestionSummary({ ...LIVE_FRAME_CONTENT, id: 'canonical' });
  assert.equal(question.id, 'canonical');
});

test('questionID alone is not enough without question text', () => {
  // The widening must not make blank rows addressable.
  assert.equal(normalizeQuestionSummary({ questionID: 'q_1', text: '   ' }), null);
  assert.equal(normalizeQuestionSummary({ questionID: '', text: 'Anything?' }), null);
});

// --- the component ---------------------------------------------------------

test('a live-shaped frame renders the question, an answer box and a Submit button', () => {
  let el = mount({
    id: 'frame_1',
    type: 'Question',
    content: LIVE_FRAME_CONTENT,
  });

  // THE REPORTED DEFECT: this used to say "Question unavailable." and render no
  // controls at all, in the very session that asked the question.
  assert.equal(
    byClass(el, 'kikx-question-frame__missing').length,
    0,
    'a real frame must not fall back to "Question unavailable."',
  );

  assert.equal(el.dataset.questionID, LIVE_FRAME_CONTENT.questionID);
  assert.match(textOf(el), /startup\.md:50/, 'the question text is visible');

  let boxes = byClass(el, 'kikx-question-frame__answer');
  assert.equal(boxes.length, 1, 'an answer box is offered');
  assert.equal(
    byClass(el, 'kikx-question-frame__submit').length,
    1,
    'a Submit control is offered',
  );
});

test('submitting from a live-shaped frame reports the real question id', () => {
  let calls = [];
  let app = {
    _submitQuestionAnswer(questionID, text) {
      calls.push({ questionID, text });
      return Promise.resolve({ delivered: true });
    },
  };
  let el = mount({ id: 'frame_1', type: 'Question', content: LIVE_FRAME_CONTENT }, { app });

  let box = byClass(el, 'kikx-question-frame__answer')[0];
  box.value = 'Yes, it is permitted.';
  el._submit(LIVE_FRAME_CONTENT.questionID, box);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].questionID,
    LIVE_FRAME_CONTENT.questionID,
    'the answer must be addressed to the id the server stored, not a placeholder',
  );
  assert.equal(calls[0].text, 'Yes, it is permitted.');
});


test('a live Question frame is attributed from its top-level frame metadata', () => {
  let el = mount({
    id: 'frame_attr',
    type: 'Question',
    sessionID: 'ses_live',
    authorID: 'agent_live',
    content: LIVE_FRAME_CONTENT,
  }, {
    agentDetailsByID: { agent_live: { id: 'agent_live', name: 'Zav' } },
    sessionDetailsByID: { ses_live: { id: 'ses_live', title: 'umbrafox' } },
  });

  assert.doesNotMatch(textOf(el), /Unattributed question/);
  assert.match(textOf(el), /Zav/);
  assert.match(textOf(el), /umbrafox/);
});
