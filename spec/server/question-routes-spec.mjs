'use strict';

// HTTP-level coverage for the ask-user answer loop: the read side the Inbox
// renders (GET /api/v1/questions) plus the write side (answer / read / dismiss).
//
// These routes are the only way a human can answer a question, so the contract
// they present to the client is worth pinning down: a stored answer is a 200
// even when delivery fails, and a terminal question never reopens.
//
// The real QuestionsStore and real QuestionAnswerService run here; only the
// frame runtime is stubbed, because delivery is its concern and is covered by
// question-wake-spec.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { QuestionsStore } from '../../src/core/questions/questions-store.mjs';
import { QuestionAnswerService } from '../../src/core/questions/question-wake.mjs';
import { createServer } from '../../src/server/create-server.mjs';
import {
  matchQuestionAnswerRoute,
  matchQuestionDismissRoute,
  matchQuestionReadRoute,
} from '../../src/server/routes/route-matchers.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

// An in-memory AeorDB stand-in: same surface the stores use, no process.
function createDatabase() {
  return {
    files: new Map(),
    async getFile(path) {
      if (!this.files.has(path)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return JSON.parse(JSON.stringify(this.files.get(path)));
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

// A frame runtime stub limited to what answer delivery touches. `participants`
// drives the deliverable/undeliverable split.
function createRuntime(options = {}) {
  let participants = options.participants ?? [ 'agent_1' ];
  let calls = { appendUserMessage: [], flush: 0 };

  return {
    calls,
    clock: () => 5000,
    idGenerator: () => 'frame_wake_1',
    async ensureSessionEntry(sessionID) {
      return {
        session: { id: sessionID, participantAgentIDs: participants, deletedAt: null },
      };
    },
    async appendUserMessage(sessionID, input) {
      calls.appendUserMessage.push({ sessionID, ...input });
      return { frame: { id: input.id } };
    },
    async flush() {
      calls.flush++;
    },
    emitRuntimeEvent() {},
  };
}

async function startServer(options = {}) {
  let db = createDatabase();
  let questionsStore = new QuestionsStore({
    aeordb: db,
    clock: () => options.now ?? 1000,
    idGenerator: idGeneratorFactory(options.ids || []),
  });
  let frameRuntime = createRuntime(options);
  let questionAnswerService = new QuestionAnswerService({
    questionsStore,
    frameRuntime,
    logger: { warn() {} },
  });

  let context = new AppContext({
    db,
    questionsStore,
    questionAnswerService,
    frameRuntime,
  });

  let server = await createServer({ context });
  let baseURL = await listen(server);
  return { server, baseURL, db, questionsStore, frameRuntime };
}

function idGeneratorFactory(ids) {
  let queue = [ ...ids ];
  let counter = 0;
  return () => {
    if (queue.length)
      return queue.shift();

    counter++;
    return `auto_${counter}`;
  };
}

// Seed one pending question straight through the store, so each test controls
// exactly what the route sees.
async function seedQuestion(stores, input = {}) {
  let result = await stores.questionsStore.createQuestions({
    questions: input.questions || [ { text: 'Which database should this use?' } ],
    mode: input.mode || 'wait',
    sessionID: input.sessionID || 'session_1',
    agentID: input.agentID || 'agent_1',
  });

  return result;
}

test('question route matchers accept exactly one id segment', () => {
  assert.deepEqual(matchQuestionAnswerRoute('/api/v1/questions/q_1/answer'), { questionID: 'q_1' });
  assert.deepEqual(matchQuestionReadRoute('/api/v1/questions/q_1/read'), { questionID: 'q_1' });
  assert.deepEqual(matchQuestionDismissRoute('/api/v1/questions/q_1/dismiss'), { questionID: 'q_1' });

  // Percent-encoding round-trips, matching the other id routes.
  assert.deepEqual(matchQuestionAnswerRoute('/api/v1/questions/a%2Fb/answer'), { questionID: 'a/b' });

  // A trailing segment is a different resource, not this one.
  assert.equal(matchQuestionAnswerRoute('/api/v1/questions/q_1/answer/extra'), null);
  assert.equal(matchQuestionReadRoute('/api/v1/questions/q_1'), null);
  assert.equal(matchQuestionDismissRoute('/api/v1/questions/read'), null);
});

test('GET /api/v1/questions lists open questions from the index with counts', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1', 'q_2' ] });

  try {
    await seedQuestion(stores, {
      questions: [
        { text: 'Which database should this use?', priority: 'high' },
        { text: 'Should the sidebar show answered questions?' },
      ],
    });

    let response = await fetch(`${stores.baseURL}/api/v1/questions`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.questions.map((question) => question.id), [ 'q_1', 'q_2' ]);
    assert.equal(body.data.questions[0].text, 'Which database should this use?');
    assert.equal(body.data.counts.open, 2);
  } finally {
    await close(stores.server);
  }
});

test('GET /api/v1/questions filters by session, agent and group', async () => {
  let stores = await startServer({ ids: [ 'g1', 'q_1', 'g2', 'q_2' ] });

  try {
    await seedQuestion(stores, { sessionID: 'session_a', agentID: 'agent_a' });
    await seedQuestion(stores, { sessionID: 'session_b', agentID: 'agent_b' });

    let bySession = await (await fetch(`${stores.baseURL}/api/v1/questions?sessionID=session_a`)).json();
    assert.deepEqual(bySession.data.questions.map((question) => question.id), [ 'q_1' ]);
    assert.equal(bySession.data.counts.open, 1);

    let byAgent = await (await fetch(`${stores.baseURL}/api/v1/questions?agentID=agent_b`)).json();
    assert.deepEqual(byAgent.data.questions.map((question) => question.id), [ 'q_2' ]);

    let byGroup = await (await fetch(`${stores.baseURL}/api/v1/questions?groupID=g2`)).json();
    assert.deepEqual(byGroup.data.questions.map((question) => question.id), [ 'q_2' ]);
  } finally {
    await close(stores.server);
  }
});

test('GET /api/v1/questions returns nothing for status=answered', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    await seedQuestion(stores);

    // The index holds open questions only, so asking for answered ones is
    // correctly empty rather than implying history lives in the index.
    let response = await fetch(`${stores.baseURL}/api/v1/questions?status=answered`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.questions, []);
    assert.equal(body.data.counts.open, 0);
  } finally {
    await close(stores.server);
  }
});

test('GET /api/v1/questions paginates and rejects a bad limit', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1', 'q_2', 'q_3' ] });

  try {
    await seedQuestion(stores, {
      questions: [ { text: 'One?' }, { text: 'Two?' }, { text: 'Three?' } ],
    });

    let page = await (await fetch(`${stores.baseURL}/api/v1/questions?limit=2&offset=1`)).json();
    assert.deepEqual(page.data.questions.map((question) => question.id), [ 'q_2', 'q_3' ]);

    // Counts describe the matching set, not the page.
    assert.equal(page.data.counts.open, 3);

    let bad = await fetch(`${stores.baseURL}/api/v1/questions?limit=0`);
    assert.equal(bad.status, 400);
  } finally {
    await close(stores.server);
  }
});

test('POST /api/v1/questions/:id/answer stores, delivers, and wakes the asker', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    await seedQuestion(stores);

    let response = await fetch(`${stores.baseURL}/api/v1/questions/q_1/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Use AeorDB, not Postgres.' }),
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.delivered, true);
    assert.equal(body.data.question.status, 'answered');
    assert.equal(body.data.question.answer, 'Use AeorDB, not Postgres.');
    assert.equal(body.data.frameID, 'frame_wake_1');

    // One targeted wake, addressed to the asking agent only.
    assert.equal(stores.frameRuntime.calls.appendUserMessage.length, 1);
    let wake = stores.frameRuntime.calls.appendUserMessage[0];
    assert.equal(wake.sessionID, 'session_1');
    assert.equal(wake.targetAgentID, 'agent_1');
    assert.equal(wake.continuation.kind, 'user-answer');
    assert.equal(wake.continuation.questionID, 'q_1');

    // Answered questions leave the open index.
    let open = await (await fetch(`${stores.baseURL}/api/v1/questions`)).json();
    assert.deepEqual(open.data.questions, []);
  } finally {
    await close(stores.server);
  }
});

test('a second answer is a 409 and writes nothing', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    await seedQuestion(stores);

    let answer = (text) => fetch(`${stores.baseURL}/api/v1/questions/q_1/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: text }),
    });

    assert.equal((await answer('first')).status, 200);

    let second = await answer('second');
    assert.equal(second.status, 409);

    let stored = await stores.questionsStore.getQuestion('q_1');
    assert.equal(stored.answer, 'first', 'the original answer is preserved');

    // Exactly one wake: the rejected answer never reaches the agent.
    assert.equal(stores.frameRuntime.calls.appendUserMessage.length, 1);
  } finally {
    await close(stores.server);
  }
});

test('POST answer rejects an empty answer and a non-JSON body', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    await seedQuestion(stores);

    let empty = await fetch(`${stores.baseURL}/api/v1/questions/q_1/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '   ' }),
    });
    assert.equal(empty.status, 400);

    let garbage = await fetch(`${stores.baseURL}/api/v1/questions/q_1/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(garbage.status, 400);

    // Still open: a rejected request must not consume the question.
    let stored = await stores.questionsStore.getQuestion('q_1');
    assert.equal(stored.status, 'open');
  } finally {
    await close(stores.server);
  }
});

test('answering an unknown question is a 404', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    let response = await fetch(`${stores.baseURL}/api/v1/questions/nope/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'anything' }),
    });

    assert.equal(response.status, 404);
  } finally {
    await close(stores.server);
  }
});

test('an undeliverable answer is still a 200 and the answer is kept', async () => {
  // The asking agent is no longer a participant: delivery fails, but losing the
  // user's words would be worse than failing to wake the bot.
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ], participants: [] });

  try {
    await seedQuestion(stores);

    let response = await fetch(`${stores.baseURL}/api/v1/questions/q_1/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Answer that cannot be delivered.' }),
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.delivered, false);
    assert.equal(body.data.frameID, null);
    assert.equal(body.data.question.status, 'undeliverable');
    assert.equal(body.data.question.answer, 'Answer that cannot be delivered.');

    assert.equal(stores.frameRuntime.calls.appendUserMessage.length, 0);
  } finally {
    await close(stores.server);
  }
});

test('POST /api/v1/questions/:id/read stamps readAt once and is idempotent', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    await seedQuestion(stores);

    let first = await fetch(`${stores.baseURL}/api/v1/questions/q_1/read`, { method: 'POST' });
    let firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.ok(firstBody.data.question.readAt, 'readAt is stamped');

    let second = await fetch(`${stores.baseURL}/api/v1/questions/q_1/read`, { method: 'POST' });
    let secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.data.question.readAt, firstBody.data.question.readAt, 'stamp is not rewritten');
  } finally {
    await close(stores.server);
  }
});

test('POST /api/v1/questions/:id/dismiss withdraws an open question', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    await seedQuestion(stores);

    let response = await fetch(`${stores.baseURL}/api/v1/questions/q_1/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'superseded by newer context' }),
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.question.status, 'dismissed');

    let open = await (await fetch(`${stores.baseURL}/api/v1/questions`)).json();
    assert.deepEqual(open.data.questions, []);
  } finally {
    await close(stores.server);
  }
});

test('POST dismiss rejects a non-string reason', async () => {
  let stores = await startServer({ ids: [ 'group_1', 'q_1' ] });

  try {
    await seedQuestion(stores);

    let response = await fetch(`${stores.baseURL}/api/v1/questions/q_1/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 42 }),
    });

    assert.equal(response.status, 400);
  } finally {
    await close(stores.server);
  }
});
