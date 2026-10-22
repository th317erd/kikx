'use strict';

// Dismiss works against BOTH server contracts.
//
// The reported failure: pressing Dismiss answered
//   "Could not dismiss the question: answer must be a non-empty string"
// on a long-running dev server whose route handlers were loaded BEFORE the
// `silent` flag existed. Client files are read from disk per request, so the
// browser ran the new dismiss client against an old route — the worst possible
// pairing: a client that sends only `silent` and a route that only knows
// `answer`.
//
// The fix is to send BOTH fields. A route with `silent` ignores the client's
// answer and composes its own literal (so a client still cannot smuggle
// agent-visible text); a route without `silent` validates the answer it was
// given and accepts the request. This spec pins both directions so neither can
// regress:
//
//   1. the request body is simultaneously valid for an old route and a new one;
//   2. the client-side marker has not drifted from the server's literal.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { dismissQuestionAnswer } = await import('../../src/client/components/kikx-inbox-view.mjs');
const clientState = await import('../../src/client/state/questions-state.mjs');
const serverFields = await import('../../src/core/questions/question-fields.mjs');

const QUESTION_ID = 'q_compat';

// The smallest app surface `dismissQuestionAnswer` touches: `_postJSON`,
// `_state`, `_syncQuestionShell`, `_requestRender`. The local state mutation is
// real, so these assertions also cover the row leaving the Inbox.
function makeApp(postJSON) {
  let app = {
    _state: {},
    _posted: [],
    _requestRender() {},
    _syncQuestionShell: () => true,
    _postJSON(url, body) {
      app._posted.push({ url, body });

      return postJSON ? postJSON(url, body) : Promise.resolve({ data: { answeredAt: 1234 } });
    },
  };

  return app;
}

// Reproduce the PRE-`silent` route exactly: validation first, then success.
// Taken from the behaviour observed on the stale process (port 3002), where
// `{"silent":true}` returned 400 "answer must be a non-empty string".
function preSilentRoute(url, body) {
  if (typeof body.answer !== 'string' || body.answer.trim() === '')
    return Promise.reject(new Error('answer must be a non-empty string'));

  return Promise.resolve({ data: { answeredAt: 1234, delivered: true } });
}

test('the dismiss marker has not drifted from the server literal', () => {
  assert.equal(
    clientState.NO_RESPONSE_ANSWER_TEXT,
    serverFields.NO_RESPONSE_ANSWER_TEXT,
    'client and server dismissal text must match: the client copy exists only '
    + 'as a compatibility payload for older routes, so drift sends stale text',
  );
});

test('a dismiss request is accepted by a route that predates `silent`', async () => {
  let app = makeApp(preSilentRoute);
  let announced = [];

  let result = await dismissQuestionAnswer(app, QUESTION_ID, {
    announce: (message, options) => announced.push({ message, options }),
  });

  assert.equal(result.ok, true, 'the pre-silent route must accept the request');
  assert.equal(app._posted.length, 1);

  let [request] = app._posted;
  assert.equal(request.url, `/api/v1/questions/${QUESTION_ID}/answer`);
  assert.equal(
    request.body.silent,
    true,
    'wake suppression must still be requested, not traded away for compatibility',
  );
  assert.equal(
    request.body.answer,
    clientState.NO_RESPONSE_ANSWER_TEXT,
    'a valid marker must ride along for routes that do not understand `silent`',
  );
  assert.equal(announced.length, 1);
  assert.equal(announced[0].options.tone, 'success');
});

test('a current server still receives explicit wake suppression', async () => {
  let app = makeApp();

  let result = await dismissQuestionAnswer(app, QUESTION_ID, { announce: () => {} });

  let [request] = app._posted;
  assert.equal(result.ok, true);
  assert.equal(request.body.silent, true);
  assert.equal(request.body.answer, serverFields.NO_RESPONSE_ANSWER_TEXT);
  // The marker must never be free text the user did not type: a client that
  // could choose the body would be able to put words in the agent's history.
  assert.equal(
    Object.keys(request.body).sort().join(','),
    'answer,silent',
    'the dismissal body carries nothing beyond the answer marker and the flag',
  );
});

test('a genuine route failure is still reported, not swallowed', async () => {
  let app = makeApp(() => Promise.reject(new Error('Question not found')));
  let announced = [];

  let result = await dismissQuestionAnswer(app, QUESTION_ID, {
    announce: (message, options) => announced.push({ message, options }),
  });

  assert.equal(result.ok, false, 'a real failure must not look like success');
  assert.match(result.message, /Could not dismiss the question: Question not found/);
  assert.equal(announced.length, 1);
  assert.equal(announced[0].options.tone, 'error');
});
