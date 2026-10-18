'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AskUserTool } from '../../../src/core/tools/index.mjs';
import { QuestionsStore } from '../../../src/core/questions/index.mjs';

test('AskUserTool persists questions and resolves without any answer existing', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1', 'q_2' ]);
  let tool = createTool({ aeordb, questionsStore });

  let result = await tool.execute({
    questions: [
      { text: 'Which database should the prod bot use?' },
      { text: 'Should answered questions stay in the sidebar?', priority: 'high' },
    ],
    mode: 'wait',
  });

  // Always-async: the promise resolves with no answer in existence.
  assert.equal(result.status, 'pending');
  assert.equal(result.groupID, 'group_1');
  assert.deepEqual(result.questionIDs, [ 'q_1', 'q_2' ]);
  assert.equal(result.mode, 'wait');
  assert.match(result.message, /pending/i);
  assert.ok(result.questions.every((question) => question.id));
  assert.ok(result.questions.every((question) => !('answer' in question) || question.answer == null));

  // Persisted before returning.
  let first = aeordb.files.get('/kikx/questions/q_1.json');
  assert.equal(first.status, 'open');
  assert.equal(first.answer, null);
  assert.equal(first.agentID, 'agent_1');
  assert.equal(first.sessionID, 'session_1');

  // Free-form only (D-4).
  assert.ok(!('options' in first));
});

test('AskUserTool stamps the agent, session, and context references', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1' ]);
  let tool = createTool({ aeordb, questionsStore });

  await tool.execute({
    questions: [ {
      text: 'Which session should own this?',
      contextRefs: [
        { type: 'session', id: 'session_9', label: 'Parent project' },
        { type: 'frame', id: 'frame_9' },
      ],
    } ],
    mode: 'continue',
  });

  let persisted = aeordb.files.get('/kikx/questions/q_1.json');
  assert.equal(persisted.mode, 'continue');
  assert.equal(persisted.agentID, 'agent_1');
  assert.equal(persisted.sessionID, 'session_1');
  assert.equal(persisted.toolCallFrameID, 'frame_root');
  assert.equal(persisted.contextRefs.length, 2);
  assert.equal(persisted.contextRefs[0].type, 'session');
  assert.equal(persisted.contextRefs[0].id, 'session_9');
  assert.equal(persisted.contextRefs[0].label, 'Parent project');
  assert.equal(persisted.contextRefs[1].type, 'frame');

  // The focus todo rides along so a stale answer still has its frame of reference.
  assert.equal(persisted.focusAtAsk, 'Ship ask-user');
  assert.deepEqual(persisted.todoIDs, [ 'todo_1' ]);
});

test('AskUserTool requires no permission prompt', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1' ]);
  let tool = createTool({ aeordb, questionsStore });

  // riskLevel 'none' short-circuits checkPermissions: no permissions service is present.
  assert.equal(AskUserTool.riskLevel, 'none');
  await assert.doesNotReject(() => tool.execute({ questions: [ { text: 'Anyone?' } ], mode: 'wait' }));
});

test('AskUserTool reports every question as a first-class reference', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1', 'q_2' ]);
  let tool = createTool({ aeordb, questionsStore });

  let result = await tool.execute({
    questions: [ { text: 'First question?' }, { text: 'Second question?' } ],
    mode: 'wait',
  });

  let references = AskUserTool.referencesFor(result);
  assert.equal(references.length, 2);
  assert.deepEqual(references.map((entry) => entry.type), [ 'question', 'question' ]);
  assert.deepEqual(references.map((entry) => entry.id), [ 'q_1', 'q_2' ]);
  assert.equal(references[0].label, 'First question?');
  assert.equal(references[0].sessionID, 'session_1');

  // Every reference satisfies the only contract: non-empty type and id.
  for (let reference of references) {
    assert.ok(typeof reference.type === 'string' && reference.type !== '');
    assert.ok(typeof reference.id === 'string' && reference.id !== '');
  }
});

test('AskUserTool rejects invalid input without persisting anything', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1' ]);
  let tool = createTool({ aeordb, questionsStore });

  await assert.rejects(
    () => tool.execute({ questions: [], mode: 'wait' }),
    /at least one question/,
  );
  await assert.rejects(
    () => tool.execute({ questions: [ { text: '' } ], mode: 'wait' }),
    /text must be a non-empty string/,
  );
  await assert.rejects(
    () => tool.execute({ questions: [ { text: 'ok', options: [ 'y', 'n' ] } ], mode: 'wait' }),
    /must not carry options/,
  );

  assert.equal([ ...aeordb.files.keys() ].filter((path) => path.startsWith('/kikx/questions/')).length, 0);
});

test('AskUserTool emits one Question frame per question and links each to its doc', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1', 'q_2' ]);
  let merged = [];
  let frameEngine = {
    idGenerator: (() => {
      let index = 0;
      return () => `frame_q_${++index}`;
    })(),
    merge(frames) {
      merged.push(...frames);
      return frames;
    },
  };
  let tool = createTool({ aeordb, questionsStore, frameEngine });

  await tool.execute({
    questions: [ { text: 'First?' }, { text: 'Second?' } ],
    mode: 'wait',
  });

  // D-3: one frame per question, tied by groupID, in P1 without a registered renderer.
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((frame) => frame.type), [ 'Question', 'Question' ]);
  assert.deepEqual(merged.map((frame) => frame.content.groupID), [ 'group_1', 'group_1' ]);
  assert.deepEqual(merged.map((frame) => frame.content.index), [ 1, 2 ]);
  assert.deepEqual(merged.map((frame) => frame.content.text), [ 'First?', 'Second?' ]);
  assert.equal(merged[0].authorType, 'agent');
  assert.equal(merged[0].authorID, 'agent_1');

  // Each question doc points back at its own frame.
  assert.equal(aeordb.files.get('/kikx/questions/q_1.json').frameID, 'frame_q_1');
  assert.equal(aeordb.files.get('/kikx/questions/q_2.json').frameID, 'frame_q_2');
});

test('AskUserTool still works when no frame engine is available', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1' ]);
  let tool = createTool({ aeordb, questionsStore, frameEngine: null });

  let result = await tool.execute({ questions: [ { text: 'Anyone?' } ], mode: 'wait' });

  // Emitting frames is best-effort: the question is persisted regardless.
  assert.equal(result.status, 'pending');
  assert.equal(aeordb.files.get('/kikx/questions/q_1.json').status, 'open');
  assert.equal(aeordb.files.get('/kikx/questions/q_1.json').frameID, null);
});

function createTool({ aeordb, questionsStore, frameEngine = undefined }) {
  return new AskUserTool({
    agent: { id: 'agent_1', name: 'Zav' },
    session: { id: 'session_1' },
    frame: { id: 'frame_root', interactionID: 'interaction_1' },
    todoState: { focus: { itemID: 'todo_1', name: 'Ship ask-user' } },
    frameEngine,
    services: { aeordb, questionsStore },
    questionsStore,
  });
}

function createStore(aeordb, ids) {
  let queue = [ ...ids ];
  return new QuestionsStore({
    aeordb,
    clock: (() => {
      let now = 1000;
      return () => now++;
    })(),
    idGenerator: () => {
      let next = queue.shift();
      if (!next)
        throw new Error('idGenerator exhausted');

      return next;
    },
  });
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
