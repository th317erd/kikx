'use strict';

// Per-question `contextRefs` must not leak across a batch.
//
// The reported failure: `ask-user-tool.mjs` collected every question's refs
// into ONE deduped array and passed it to the store as a batch-wide value,
// while `normalizeQuestionList` (the store's per-question field allow-list) did
// not list `contextRefs` at all. The store therefore had no per-question channel
// to receive refs through, and `createQuestions` wrote that single unioned array
// onto EVERY row. Asking three questions with different refs stored all three
// questions with all of them.
//
// The existing suite could not see this: `ask-user-tool-spec.mjs` uses a
// one-question batch, and a one-question batch is structurally incapable of
// telling per-question storage apart from group-wide storage. These tests use a
// multi-question batch on purpose.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AskUserTool, QuestionListTool } from '../../../src/core/tools/index.mjs';
import { QuestionsStore } from '../../../src/core/questions/index.mjs';

const ref = (type, id, label) => (label ? { type, id, label } : { type, id });

test('contextRefs are stored per question, not unioned across the batch', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1', 'q_2', 'q_3' ]);
  let tool = createTool({ aeordb, questionsStore });

  let result = await tool.execute({
    questions: [
      {
        text: 'First?',
        contextRefs: [ ref('session', 'session_9', 'Parent project'), ref('file', 'a.mjs') ],
      },
      // Deliberately carries NO refs: before the fix this row inherited the
      // other questions' references.
      { text: 'Second?' },
      { text: 'Third?', contextRefs: [ ref('todo', 'todo_7') ] },
    ],
    mode: 'wait',
  });

  let first = aeordb.files.get('/kikx/questions/q_1.json');
  let second = aeordb.files.get('/kikx/questions/q_2.json');
  let third = aeordb.files.get('/kikx/questions/q_3.json');

  assert.deepEqual(first.contextRefs.map((entry) => `${entry.type}:${entry.id}`), [
    'session:session_9',
    'file:a.mjs',
  ]);
  // The empty one stays empty. This assertion is the regression: it failed with
  // all three references copied onto it.
  assert.deepEqual(second.contextRefs, []);
  assert.deepEqual(third.contextRefs.map((entry) => `${entry.type}:${entry.id}`), [ 'todo:todo_7' ]);

  // Labels survive normalisation, and the label-less ref gets an explicit null
  // rather than the key being absent.
  assert.equal(first.contextRefs[0].label, 'Parent project');
  assert.equal(first.contextRefs[1].label, null);

  // The tool's own response must agree with what was persisted, or an agent
  // cannot detect the corruption from its return value.
  assert.deepEqual(
    result.questions.map((question) => question.contextRefs.length),
    [ 2, 0, 1 ],
  );
});

test('a batch-level contextRefs acts as a fallback for questions without their own', async () => {
  let aeordb = createClient();
  let ids = [ 'group_1', 'q_1', 'q_2' ];
  let store = createStore(aeordb, ids);

  // Called at the store level: the tool no longer sends a batch-level value, but
  // the parameter is still accepted for callers that frame a whole group.
  await store.createQuestions({
    questions: [
      { text: 'Own refs', contextRefs: [ ref('file', 'own.mjs') ] },
      { text: 'Inherits the group refs' },
    ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
    contextRefs: [ ref('session', 'session_1', 'Main') ],
  });

  assert.deepEqual(
    aeordb.files.get('/kikx/questions/q_1.json').contextRefs.map((entry) => entry.id),
    [ 'own.mjs' ],
  );
  assert.deepEqual(
    aeordb.files.get('/kikx/questions/q_2.json').contextRefs.map((entry) => entry.id),
    [ 'session_1' ],
  );
});

test('invalid contextRefs are dropped per question without invalidating the batch', async () => {
  let aeordb = createClient();
  let store = createStore(aeordb, [ 'group_1', 'q_1', 'q_2' ]);

  await store.createQuestions({
    questions: [
      { text: 'Bad refs', contextRefs: [ { type: 'file' }, null, 'nonsense', { type: 'file', id: 42 } ] },
      { text: 'Good refs', contextRefs: [ ref('frame', 'frame_1') ] },
    ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  // A ref needs BOTH a type and an id; the rest (missing type, null, a bare
  // string) are dropped and never invalidate the batch. Note that a NUMERIC id
  // is coerced, because `normalizeOptionalString` is `String(value).trim()`, so
  // `{ type: 'file', id: 42 }` is stored as id '42'. That leniency predates this
  // change; it is recorded here as observed behaviour, not endorsed.
  assert.deepEqual(
    aeordb.files.get('/kikx/questions/q_1.json').contextRefs.map((entry) => `${entry.type}:${entry.id}`),
    [ 'file:42' ],
  );
  assert.deepEqual(
    aeordb.files.get('/kikx/questions/q_2.json').contextRefs.map((entry) => entry.id),
    [ 'frame_1' ],
  );
});

function createStore(aeordb, ids) {
  let queue = [ ...ids ];
  let now = 1000;
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

function createTool({ aeordb, questionsStore, frameEngine = null }) {
  let tool = new AskUserTool();
  tool.context = {
    services: { aeordb, questionsStore, ...(frameEngine ? { frameEngine } : {}) },
    frameRuntime: null,
    frame: { id: 'frame_root', interactionID: 'interaction_1' },
    session: { id: 'session_1' },
    agent: { id: 'agent_1' },
    todoState: null,
    // `flushFrameStore` is a no-op without a frame runtime.
  };
  return withDigest(tool, tool.context);
}

function createClient() {
  return {
    files: new Map(),
    async getFile(path) {
      if (!this.files.has(path)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return this.files.get(path);
    },
    async putFile(path, body) {
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async deleteFile(path) {
      this.files.delete(path);
      return { path };
    },
    async list(path, options = {}) {
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let glob = options.glob || null;
      let pattern = glob ? new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`) : null;
      let items = [];

      for (let key of this.files.keys()) {
        if (!key.startsWith(prefix))
          continue;

        let rest = key.slice(prefix.length);
        if (rest.includes('/'))
          continue;

        if (pattern && !pattern.test(rest))
          continue;

        items.push({ path: key });
      }

      return { items, total: items.length, hasMore: false };
    },
  };
}

// ask-user now demands proof that the agent looked first (see
// question-dedupe.mjs). These specs predate that gate and are about the ask
// itself, so they inject the current digest. The gate's own behaviour — absent,
// stale, and duplicate digests — is covered by question-dedupe-spec.mjs with a
// raw tool.
async function currentQuestionDigest(context) {
  let lister = new QuestionListTool(context);
  let listed = await lister.execute({});
  return listed.openDigest;
}

function withDigest(tool, context) {
  let execute = tool.execute.bind(tool);
  tool.execute = async (params = {}) => {
    let observedQuestionDigest = params.observedQuestionDigest
      || await currentQuestionDigest(context);
    return execute({ ...params, observedQuestionDigest });
  };
  return tool;
}
