'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QuestionAnswerTool,
  QuestionCreateTool,
  QuestionDismissTool,
  QuestionGetTool,
} from '../../../src/core/tools/question-tools.mjs';

function question(overrides = {}) {
  return {
    id: 'q1',
    groupID: 'g1',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'ses_1',
    agentID: 'agent_1',
    text: 'Which option?',
    priority: 'normal',
    askedAt: 1,
    answer: null,
    answerSource: null,
    contextRefs: [],
    ...overrides,
  };
}

test('question-get returns one question by id', async () => {
  let store = { async getQuestion(id) { return question({ id }); } };
  let tool = new QuestionGetTool({ questionsStore: store });
  let result = await tool._execute({ question_id: 'q1' });
  assert.equal(result.id, 'q1');
  assert.equal(result.text, 'Which option?');
});

test('question-answer is coordinator-only and records agent provenance', async () => {
  let calls = [];
  let service = {
    async submitAnswer(id, input) {
      calls.push({ id, input });
      return { delivered: true, question: question({ status: 'answered', answer: input.answer, answerSource: 'agent' }), frameID: 'wake_1' };
    },
  };
  let tool = new QuestionAnswerTool({ questionsStore: {}, questionAnswerService: service, isCoordinator: false, agent: { id: 'agent_1' } });
  await assert.rejects(() => tool._execute({ question_id: 'q1', answer: 'yes' }), /coordinator-only/);

  tool = new QuestionAnswerTool({ questionsStore: {}, questionAnswerService: service, isCoordinator: true, agent: { id: 'agent_1', name: 'Zav' } });
  let result = await tool._execute({ question_id: 'q1', answer: 'yes' });
  assert.equal(result.delivered, true);
  assert.equal(result.question.answer, 'yes');
  assert.equal(calls[0].input.answerSource, 'agent');
  assert.equal(calls[0].input.answeredByAgentID, 'agent_1');
});

test('question-dismiss is coordinator-only and emits an update', async () => {
  let events = [];
  let store = {
    async dismissQuestion(id, input) {
      return question({ id, status: 'dismissed', dismissalReason: input.reason });
    },
  };
  let runtime = { emitRuntimeEvent(type, payload) { events.push({ type, payload }); } };
  let tool = new QuestionDismissTool({ questionsStore: store, frameRuntime: runtime, isCoordinator: true });
  let result = await tool._execute({ question_id: 'q1', reason: 'obsolete' });
  assert.equal(result.status, 'dismissed');
  assert.equal(events[0].type, 'question.updated');
  assert.equal(events[0].payload.reason, 'dismissed');
});

test('question-create exposes the REST-style create tool', () => {
  assert.equal(QuestionCreateTool.featureName, 'question-create');
  assert.match(QuestionCreateTool.description, /REST-style/);
});
