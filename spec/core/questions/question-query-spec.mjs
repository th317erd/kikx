'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { queryQuestions } from '../../../src/core/questions/question-query.mjs';

function question(overrides = {}) {
  return {
    id: 'q1',
    groupID: 'g1',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'root',
    agentID: 'agent_1',
    text: 'Is this concerning?',
    priority: 'normal',
    askedAt: 1,
    answeredAt: null,
    answer: null,
    answerSource: null,
    contextRefs: [],
    ...overrides,
  };
}

function store(questions = []) {
  return {
    questions,
    async listSessionTree() {
      return [
        { id: 'root', parentSessionID: null },
        { id: 'child', parentSessionID: 'root' },
        { id: 'other', parentSessionID: null },
      ];
    },
    async listOpen(filters = {}) {
      let sessionIDs = filters.rootSessionID ? [ 'root', 'child' ] : filters.sessionID ? [ filters.sessionID ] : [ 'root', 'child', 'other' ];
      let summaries = this.questions
        .filter((entry) => entry.status === 'open' && sessionIDs.includes(entry.sessionID))
        .filter((entry) => !filters.query || entry.text.toLowerCase().includes(filters.query.toLowerCase()))
        .map((entry) => ({ ...entry }));
      return { summaries, ids: summaries.map((entry) => entry.id), updatedAt: 1 };
    },
    async readQuestionsByID(ids) {
      return this.questions.filter((entry) => ids.includes(entry.id));
    },
    async listQuestionsInSessions(sessionIDs) {
      return this.questions.filter((entry) => sessionIDs.includes(entry.sessionID));
    },
  };
}

test('question queries scope to a session tree by default and support text filters', async () => {
  let source = store([
    question({ id: 'q1', sessionID: 'root', text: 'Concerning parser failure' }),
    question({ id: 'q2', sessionID: 'child', text: 'Concerning child failure' }),
    question({ id: 'q3', sessionID: 'other', text: 'Concerning unrelated failure' }),
  ]);

  let tree = await queryQuestions(source, { sessionID: 'root', query: 'concerning' });
  assert.equal(tree.scope, 'tree');
  assert.deepEqual(tree.questions.map((entry) => entry.id), [ 'q1', 'q2' ]);
  assert.equal(tree.openDigest.length, 64);

  let exact = await queryQuestions(source, { sessionID: 'root', scope: 'session' });
  assert.deepEqual(exact.questions.map((entry) => entry.id), [ 'q1' ]);

  let all = await queryQuestions(source, { scope: 'all' });
  assert.deepEqual(all.questions.map((entry) => entry.id), [ 'q1', 'q2', 'q3' ]);
});

test('question queries can include terminal history and paginate', async () => {
  let source = store([
    question({ id: 'q1', status: 'answered', answer: 'yes', answeredAt: 2 }),
    question({ id: 'q2', status: 'dismissed' }),
    question({ id: 'q3', status: 'open' }),
  ]);

  let result = await queryQuestions(source, { sessionID: 'root', status: 'all', limit: 1, offset: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.questions.length, 1);
  assert.equal(result.hasMore, true);
});
