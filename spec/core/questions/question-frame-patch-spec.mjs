'use strict';

// The stored `Question` frame must stop saying "open" once its question is
// answered.
//
// The defect these pin (reported with a screenshot): after submitting an answer,
// the thread still showed the answer box and a live Submit button, on a question
// that had already been answered. The client-only "sent" state kept the right
// pixels for the node you had just used, but the frame content underneath was
// frozen at ask time (`status:'open'`, no `answer`), so every re-render rebuilt
// the empty form and the button came back.
//
// These specs run against the real `FrameEngine` so the merge semantics are the
// product's, not a stub's: a patch that replaced the frame instead of merging
// into it would silently drop `text`, `askedAt` and `priority`, and the tests
// below would catch that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { register } from 'node:module';
register(new URL('../../client/support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

import { FrameEngine } from '../../../src/core/frames/frame-engine.mjs';
import { patchQuestionFrameContent } from '../../../src/core/questions/question-frame-patch.mjs';

const SESSION_ID = 'session_1';
const FRAME_ID = 'question:q_1';

function questionFrame(overrides = {}) {
  return {
    id: FRAME_ID,
    type: 'Question',
    sessionID: SESSION_ID,
    authorType: 'agent',
    authorID: 'agent_1',
    timestamp: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    content: {
      id: 'q_1',
      questionID: 'q_1',
      text: 'Which database should we use?',
      priority: 'high',
      mode: 'wait',
      status: 'open',
      askedAt: 1000,
      contextRefs: [ { type: 'file', id: 'src/db.mjs' } ],
    },
    ...overrides,
  };
}

function runtimeWith(engine) {
  let flushCalls = 0;
  return {
    flushCalls: () => flushCalls,
    ensureSessionEntry: async () => ({ frameEngine: engine }),
    frameStore: { flush: async () => { flushCalls += 1; } },
  };
}

function engineWith(frame) {
  let engine = new FrameEngine({ history: false });
  engine.merge([ frame ], { authorType: 'agent', authorID: 'agent_1' });
  return engine;
}

function answeredQuestion(overrides = {}) {
  return {
    id: 'q_1',
    sessionID: SESSION_ID,
    frameID: FRAME_ID,
    status: 'answered',
    answer: 'PostgreSQL.',
    answeredAt: 2000,
    ...overrides,
  };
}

test('the answered state is merged into the stored frame', async () => {
  let engine = engineWith(questionFrame());
  let runtime = runtimeWith(engine);

  let patched = await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });

  assert.equal(patched, true);

  let content = engine.get(FRAME_ID).content;
  assert.equal(content.status, 'answered', 'the frame no longer reads open');
  assert.equal(content.answer, 'PostgreSQL.', 'the frame carries what was said');
  assert.equal(content.answeredAt, 2000);
});

test('patching keeps every field the question was asked with', async () => {
  let engine = engineWith(questionFrame());
  let runtime = runtimeWith(engine);

  await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });

  let content = engine.get(FRAME_ID).content;

  // A replace-instead-of-merge would drop all of these. `_question()` needs
  // `text` to render at all, and without `id` the card falls back to
  // "Question unavailable."
  assert.equal(content.text, 'Which database should we use?');
  assert.equal(content.id, 'q_1');
  assert.equal(content.questionID, 'q_1');
  assert.equal(content.priority, 'high');
  assert.equal(content.mode, 'wait');
  assert.equal(content.askedAt, 1000);
  assert.deepEqual(content.contextRefs, [ { type: 'file', id: 'src/db.mjs' } ]);
});

test('the frame patch is silent, so it does not start an agent turn', async () => {
  let engine = engineWith(questionFrame());

  // `silent` is what the runtime keys on to skip routing. Asserting on the real
  // commit is stronger than spying on the call: a merge that were loud would
  // wake the asking agent for a record edit.
  let commits = [];
  engine.on('commit', (payload) => commits.push(payload));

  await patchQuestionFrameContent({}, answeredQuestion(), {
    frameRuntime: runtimeWith(engine),
  });

  assert.equal(commits.length, 1, 'the patch is committed');
  assert.equal(commits[0].commit.silent, true, 'a record update must not be routed as a message');
});

test('the patch is flushed to the frame store', async () => {
  let engine = engineWith(questionFrame());
  let runtime = runtimeWith(engine);

  await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });

  assert.equal(runtime.flushCalls(), 1, 'an unflushed patch is lost on reload');
});

test('a question with no frame is not an error', async () => {
  let engine = engineWith(questionFrame());
  let runtime = runtimeWith(engine);

  // Questions asked before frames were attached (or imported ones) have no
  // frameID. That is a display downgrade, not a failure of the answer.
  let patched = await patchQuestionFrameContent({}, answeredQuestion({ frameID: null }), {
    frameRuntime: runtime,
  });

  assert.equal(patched, false);
});

test('a frame that is not loaded is skipped rather than invented', async () => {
  let engine = new FrameEngine({ history: false });
  let runtime = runtimeWith(engine);

  let patched = await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });

  assert.equal(patched, false);
  assert.equal(engine.get(FRAME_ID), undefined, 'no frame is created for a question that had none');
});

test('a throwing runtime cannot fail the answer', async () => {
  let runtime = {
    ensureSessionEntry: async () => { throw new Error('session gone'); },
    frameStore: { flush: async () => {} },
  };

  // The answer is already durable in the questions store by the time this runs.
  // Losing the cosmetic patch must never surface as a failed answer.
  let patched = await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });

  assert.equal(patched, false);
});

test('an undeliverable answer still records its text on the frame', async () => {
  let engine = engineWith(questionFrame());
  let runtime = runtimeWith(engine);

  await patchQuestionFrameContent({}, answeredQuestion({ status: 'undeliverable' }), {
    frameRuntime: runtime,
  });

  let content = engine.get(FRAME_ID).content;
  assert.equal(content.status, 'undeliverable');
  assert.equal(content.answer, 'PostgreSQL.', 'the user text is kept, never dropped');
});

test('re-patching an already-answered frame is idempotent', async () => {
  let engine = engineWith(questionFrame());
  let runtime = runtimeWith(engine);

  await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });
  await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });

  let content = engine.get(FRAME_ID).content;
  assert.equal(content.status, 'answered');
  assert.equal(content.answer, 'PostgreSQL.');
  assert.equal(content.text, 'Which database should we use?');
});

test('the patched frame is what the client normalizer renders as answered', async () => {
  let engine = engineWith(questionFrame());
  let runtime = runtimeWith(engine);

  await patchQuestionFrameContent({}, answeredQuestion(), { frameRuntime: runtime });

  // The frame the client would receive after a reload. This is the join between
  // the server patch and the card: if the shape here is wrong, `_question()`
  // returns null and the row renders "Question unavailable." instead.
  let { normalizeQuestionSummary } = await import('../../../src/client/state/questions-state.mjs');
  let summary = normalizeQuestionSummary(engine.get(FRAME_ID).content);

  assert.ok(summary, 'the patched content normalizes');
  assert.equal(summary.id, 'q_1');
  assert.equal(summary.status, 'answered', 'the reloaded card shows the answered state');
  assert.equal(summary.answer, 'PostgreSQL.', 'and the answer it holds');
});

// --- Wiring: the answer path must actually call the patch -------------------
//
// The tests above exercise `patchQuestionFrameContent` directly, and a mutation
// that deleted its call site in `submitAnswer` killed NONE of them: they all
// passed. That is the vacuous-guard trap this session kept hitting — a spec that
// proves a function works while the product never calls it. The test below goes
// through the real `submitAnswer` and the real store, so it dies if the call is
// removed.

import { QuestionAnswerService, QuestionsStore } from '../../../src/core/questions/index.mjs';

function storeFor(ids) {
  let queue = [ ...ids ];
  let files = new Map();
  let aeordb = {
    async getFile(path) {
      if (!files.has(path)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }
      return files.get(path);
    },
    async putFile(path, body) {
      files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async deleteFile(path) { files.delete(path); },
    // The real client returns `{items,total,hasMore}`, not a bare array. A stub
    // that returned `[]` made every question invisible, and the failure looked
    // like a product bug ("Question not found: q_1") rather than a bad fixture.
    async list(path) {
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let items = [];
      for (let key of files.keys()) {
        if (!key.startsWith(prefix))
          continue;
        let rest = key.slice(prefix.length);
        if (rest.includes('/'))
          continue;
        items.push({ path: key });
      }
      return { items, total: items.length, hasMore: false };
    },
  };

  let now = 5000;
  return new QuestionsStore({
    aeordb,
    clock: () => now++,
    idGenerator: () => {
      let next = queue.shift();
      if (!next)
        throw new Error('idGenerator exhausted');
      return next;
    },
  });
}

function answerRuntime(engine) {
  return {
    flushOptions: [],
    // Delivery reads `entry.session.participantAgentIDs`; without it the service
    // reports `origin-session-missing` and marks the answer undeliverable.
    async ensureSessionEntry(sessionID) {
      return {
        frameEngine: engine,
        session: {
          id: sessionID || SESSION_ID,
          participantAgentIDs: [ 'agent_1' ],
          deletedAt: null,
        },
      };
    },
    async appendUserMessage(sessionID, input) {
      return { frame: { id: input.id, type: 'UserMessage' }, wakePending: true };
    },
    async flush(options = {}) { this.flushOptions.push(options); },
    frameStore: { flush: async () => {} },
    emitRuntimeEvent() {},
  };
}

test('answering a question patches the frame the thread renders from', async () => {
  let engine = new FrameEngine({ history: false });
  let runtime = answerRuntime(engine);

  // The frame as ask-user-tool wrote it: open, no answer.
  engine.merge([ questionFrame() ], { authorType: 'agent', authorID: 'agent_1' });

  // createQuestions() draws one id for the group, then one per question.
  let questionsStore = storeFor([ 'group_1', 'q_1' ]);
  let service = new QuestionAnswerService({
    questionsStore,
    frameRuntime: runtime,
    logger: { warn() {}, error() {} },
  });

  await questionsStore.createQuestions({
    questions: [ { text: 'Which database should we use?' } ],
    mode: 'wait',
    sessionID: SESSION_ID,
    agentID: 'agent_1',
    frameID: FRAME_ID,
  });

  await service.submitAnswer('q_1', { answer: 'PostgreSQL.', userID: 'user_1' });

  let content = engine.get(FRAME_ID).content;
  assert.equal(content.status, 'answered', 'the thread copy stops reading open');
  assert.equal(content.answer, 'PostgreSQL.', 'and carries the answer');
  assert.equal(content.text, 'Which database should we use?', 'without losing the question');
});
