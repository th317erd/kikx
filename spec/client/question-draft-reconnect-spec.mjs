'use strict';

// Typed answers must survive a connect / reconnect / refresh of the transcript.
//
// The reported bug, verbatim: "Disconnecting, Reconnecting, or Connecting WIPES
// my in-progress response while I am trying to answer an `ask-user` question".
//
// Why the existing coverage missed it: `question-drafts-spec.mjs` proves the
// *store* and the *Inbox card* both preserve drafts, and it does so by writing
// to the store directly. It never touches `kikx-question-frame.mjs` — the inline
// `Question` frame, which is the surface the user answers in inside the
// transcript. That component had no draft wiring at all, so its `_render()`
// rebuilt an empty `textarea` on every refresh and threw the text away.
//
// The reconnect path that triggers the rebuild, traced end to end:
//   socket reopens -> onRuntimeEventsOpen -> _onRuntimeEventsReconnect
//   -> resyncAfterRuntimeEventsReconnect -> loadFrames
//   -> kikx-chat-view.mjs:350  item.updateFrame(frame, appState)
//   -> kikx-frame-item.mjs:519-531  element.appState = ...; element.updateFrame(...)
//   -> KikxQuestionFrame.updateFrame -> _render() -> this.textContent = ''
//
// So the test drives `updateFrame()` — the exact call a reconnect makes — rather
// than a hand-waved "re-render".

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { KikxQuestionFrame } = await import('../../src/client/components/kikx-question-frame.mjs');
const { createQuestionsState } = await import('../../src/client/state/questions-state.mjs');
const {
  createDraftStore,
  getAnswerDraft,
  pruneAnswerDrafts,
  setAnswerDraft,
} = await import('../../src/client/state/question-drafts.mjs');

// The shape the server actually emits in `content` (ask-user-tool.mjs
// `emitQuestionFrames`): a flat question document under `questionID`, not
// wrapped in `question.id`.
function questionContent(overrides = {}) {
  return {
    questionID: 'q_reconnect',
    groupID: 'group_reconnect',
    index: 1,
    text: 'Which database driver should the next release target?',
    priority: 'normal',
    mode: 'wait',
    status: 'open',
    contextRefs: [],
    askedAt: 1792468917954,
    ...overrides,
  };
}

// An app shaped like the real one: `_state.questionsState` exists, and
// `_submitQuestionAnswer` is the handler the frame calls.
function createApp() {
  return {
    _state: { questionsState: createQuestionsState() },
    ownerDocument: document,
    renders: 0,
    _requestRender() { this.renders += 1; },
    _syncQuestionShell() { return false; },
    _submitQuestionAnswer: async () => ({ ok: true, delivered: true }),
  };
}

// Mounts the frame the way `kikx-frame-item.mjs` does: create the element, hand
// it the appState, then update it with a frame.
function mount(app, content = questionContent()) {
  let host = document.createElement('kikx-question-frame');
  host.appState = { app };
  host.updateFrame({ id: 'frame_reconnect', type: 'Question', content }, { app });
  return host;
}

function nodes(node, out = []) {
  for (let child of node?.childNodes || []) {
    out.push(child);
    nodes(child, out);
  }
  return out;
}

function answerBox(host) {
  return host.querySelector?.('.kikx-question-frame__answer') || null;
}

// What the browser does when a person types. mini-dom stores `.value` and the
// frame's `input` listener mirrors it into the store, exactly as the platform
// fires `input` on every keystroke.
function type(host, text) {
  let box = answerBox(host);
  assert.ok(box, 'the frame must render an answer box for an open question');
  box.value = text;
  box.dispatchEvent({ type: 'input' });
  return box;
}

test('typing into the inline frame records the text in the shared draft store', () => {
  let app = createApp();
  let host = mount(app);

  type(host, 'PostgreSQL.');

  assert.equal(
    getAnswerDraft(app._answerDrafts, 'q_reconnect'),
    'PostgreSQL.',
    'every keystroke must reach the store, or a rebuild has nothing to restore',
  );
});

test('a reconnect re-render does not wipe the answer being typed', () => {
  let app = createApp();
  let host = mount(app);

  type(host, 'Ship PostgreSQL, retire AeorDB');

  // This is the reconnect: same element, same frame, `updateFrame()` again.
  // Before the fix `_render()` cleared the box and rebuilt it empty, so the
  // user's half-written answer disappeared mid-sentence.
  host.updateFrame({ id: 'frame_reconnect', type: 'Question', content: questionContent() }, { app });

  let box = answerBox(host);
  assert.ok(box, 'the box is still there after the refresh');
  assert.equal(
    box.value,
    'Ship PostgreSQL, retire AeorDB',
    'the typed-but-unsubmitted answer survives the reconnect',
  );
});

test('an appState-only refresh (no new frame) also preserves the text', () => {
  // `set appState` re-renders too, and the chat view reassigns appState on
  // paths that do not carry a new frame. It must be just as non-destructive.
  let app = createApp();
  let host = mount(app);
  type(host, 'half an answer');

  host.appState = { app };

  assert.equal(answerBox(host).value, 'half an answer');
});

test('the frame and the Inbox card share one draft per question id', () => {
  // One store, two surfaces: text typed in the transcript must still be there
  // if the user opens the Inbox, and vice versa. A per-component store would
  // silently give each surface its own half-answer.
  let app = createApp();
  let host = mount(app);
  type(host, 'typed in the transcript');

  assert.equal(
    getAnswerDraft(app._answerDrafts, 'q_reconnect'),
    'typed in the transcript',
    'the frame writes to the app-level store the Inbox card also reads',
  );
});

test('a fresh question is unaffected by another question\'s draft', () => {
  // The user's standing constraint: never disturb drafts on other questions.
  let app = createApp();
  setAnswerDraft(app._answerDrafts, 'q_other', 'text for a different question');

  let host = mount(app);

  assert.equal(answerBox(host).value ?? '', '', 'an untouched question renders an empty box');
});

test('a re-render restores the draft even after the element is rebuilt from scratch', () => {
  // A session switch does not reuse the element: a new `kikx-question-frame` is
  // constructed and mounted. The text lives in the app store, not the element,
  // so it must come back.
  let app = createApp();
  type(mount(app), 'survives being thrown away');

  let rebuilt = mount(app);

  assert.equal(
    answerBox(rebuilt).value,
    'survives being thrown away',
    'a brand-new element restores the draft from the app store',
  );
});

test('sending the answer clears the draft so it cannot come back after a reload', async () => {
  let app = createApp();
  let host = mount(app);
  type(host, 'this is my final answer');

  // Proving the clear means this test would fail if the draft were simply never
  // written: without the keystroke wiring the store is empty here and the
  // assertion below would pass for the wrong reason. Assert the precondition.
  assert.equal(
    getAnswerDraft(app._answerDrafts, 'q_reconnect'),
    'this is my final answer',
    'precondition: the draft exists before sending',
  );

  host.querySelector('.kikx-question-frame__submit').dispatchEvent({ type: 'click' });

  // `_submit` awaits the app's promise; drain its continuations.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    getAnswerDraft(app._answerDrafts, 'q_reconnect'),
    '',
    'a delivered answer must not resurrect itself as a draft',
  );
});

test('a failed send keeps the draft, so the text is not lost', async () => {
  // A rejected answer must not destroy the text: the user has to be able to
  // retry. This is the same requirement, from the failure side.
  let app = createApp();
  app._submitQuestionAnswer = async () => ({ ok: false, reason: 'error', message: 'nope' });

  let host = mount(app);
  type(host, 'keep me');
  assert.equal(
    getAnswerDraft(app._answerDrafts, 'q_reconnect'),
    'keep me',
    'precondition: the draft is written before the send is attempted',
  );
  host.querySelector('.kikx-question-frame__submit').dispatchEvent({ type: 'click' });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    getAnswerDraft(app._answerDrafts, 'q_reconnect'),
    'keep me',
    'a failed send leaves the draft in place for a retry',
  );
});

// --- the fetch that runs on every (re)connect -----------------------------------
//
// `fetchQuestions` is the reconnect resync: the runtime-events stream keeps no
// replay buffer, so the client refetches the open set whenever the socket
// reopens. It also prunes drafts against that response. If the response is
// truncated by the page limit, the ids it does not contain are *unobserved*, not
// closed, and pruning against them deleted an answer being typed for a question
// on a later page — on a reconnect, which is exactly the reported symptom.

test('a truncated open-question page does not prune drafts it never saw', () => {
  let store = createDraftStore();
  setAnswerDraft(store, 'q_page_1', 'on the page the server returned');
  setAnswerDraft(store, 'q_page_2', 'still open, past the limit, being typed right now');

  pruneAnswerDrafts(store, new Set([ 'q_page_1' ]), { complete: false });

  assert.equal(getAnswerDraft(store, 'q_page_1'), 'on the page the server returned');
  assert.equal(
    getAnswerDraft(store, 'q_page_2'),
    'still open, past the limit, being typed right now',
    'an unobserved question is not a closed one',
  );
});

test('a complete page still prunes drafts for questions answered elsewhere', () => {
  // The guard must not disable pruning outright: when the server enumerated the
  // whole open set, a draft with no matching question really is dead text.
  let store = createDraftStore();
  setAnswerDraft(store, 'q_open', 'keep me');
  setAnswerDraft(store, 'q_answered_elsewhere', 'drop me');

  pruneAnswerDrafts(store, new Set([ 'q_open' ]), { complete: true });

  assert.equal(getAnswerDraft(store, 'q_open'), 'keep me');
  assert.equal(getAnswerDraft(store, 'q_answered_elsewhere'), '');
});
