'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { AskUserTool } from './ask-user-tool.mjs';

function questionsStore(context) {
  let store = context.questionsStore
    || context.services?.questionsStore
    || context.services?.context?.require?.('questionsStore');
  if (!store)
    throw new Error('question tools require questionsStore');
  return store;
}

function answerService(context) {
  let service = context.questionAnswerService
    || context.services?.questionAnswerService
    || context.services?.context?.require?.('questionAnswerService');
  if (!service?.submitAnswer)
    throw new Error('question-answer requires questionAnswerService');
  return service;
}

function agentID(context) {
  let id = normalizeOptionalString(context.agent?.id);
  if (!id)
    throw new Error('question tools require an agent context');
  return id;
}

function questionID(params = {}) {
  let id = normalizeOptionalString(params.question_id || params.questionID || params.id);
  if (!id)
    throw new TypeError('question_id is required');
  return id;
}

function requireCoordinator(context) {
  if (context.isCoordinator !== true)
    throw new Error('this question operation is coordinator-only');
}

export class QuestionCreateTool extends AskUserTool {
  static featureName = 'question-create';
  static displayName = 'Create questions';
  static description = 'Create one or more questions for the user, REST-style. Answers arrive later as a wake. Requires question-list first via observedQuestionDigest.';
  static help = AskUserTool.help
    .replaceAll('ask-user', 'question-create')
    .replace('Use question-create only', 'Use question-create only');
}

export class QuestionGetTool extends PluginInterface {
  static pluginID = 'internal:questions';
  static featureName = 'question-get';
  static displayName = 'Get question';
  static description = 'Fetch one question by id, including status, answer, provenance, context refs, and default-answer metadata.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      question_id: { type: 'string', description: 'Question id.' },
    },
    required: [ 'question_id' ],
    additionalProperties: false,
  };
  static help = 'Fetch one question by id. Use this to inspect a specific row without listing a whole session tree.';

  async _execute(params = {}) {
    let question = await questionsStore(this.context).getQuestion(questionID(params));
    return publicQuestion(question);
  }
}

export class QuestionAnswerTool extends PluginInterface {
  static pluginID = 'internal:questions';
  static featureName = 'question-answer';
  static displayName = 'Answer question';
  static description = 'Coordinator-only: answer a pending question on the user\'s behalf and wake the asking agent with the answer.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      question_id: { type: 'string', description: 'Question id.' },
      answer: { type: 'string', description: 'Answer text to deliver to the asking agent.' },
      note: { type: 'string', description: 'Optional internal note; not stored as the answer.' },
    },
    required: [ 'question_id', 'answer' ],
    additionalProperties: false,
  };
  static help = 'Coordinator-only. Answer a question that is waiting on the user, recording the answer as agent-provided and waking the asking agent. Do not use this for a question only the user can decide.';

  async _execute(params = {}) {
    requireCoordinator(this.context);
    let answer = normalizeRequiredString(params.answer, 'answer');
    let result = await answerService(this.context).submitAnswer(questionID(params), {
      answer,
      answerSource: 'agent',
      answeredByAgentID: agentID(this.context),
      authorDisplayName: this.context.agent?.name || null,
    });
    return {
      question: publicQuestion(result.question),
      delivered: result.delivered === true,
      pending: result.pending === true,
      suppressed: result.suppressed === true,
      reason: result.reason || null,
      frameID: result.frameID || null,
    };
  }
}

export class QuestionDismissTool extends PluginInterface {
  static pluginID = 'internal:questions';
  static featureName = 'question-dismiss';
  static displayName = 'Dismiss question';
  static description = 'Coordinator-only: dismiss/withdraw a question without waking the asking agent.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      question_id: { type: 'string', description: 'Question id.' },
      reason: { type: 'string', description: 'Optional reason recorded with the dismissal.' },
    },
    required: [ 'question_id' ],
    additionalProperties: false,
  };
  static help = 'Coordinator-only. Dismiss a question without waking the asking agent. Use when the question is obsolete, duplicated, or should no longer interrupt the user.';

  async _execute(params = {}) {
    requireCoordinator(this.context);
    let store = questionsStore(this.context);
    let question = await store.dismissQuestion(questionID(params), {
      reason: normalizeOptionalString(params.reason) || null,
    });
    let runtime = this.context?.services?.frameRuntime || this.context?.frameRuntime;
    runtime?.emitRuntimeEvent?.('question.updated', {
      sessionID: question.sessionID,
      question,
      reason: 'dismissed',
    });
    return { question: publicQuestion(question), status: question.status };
  }
}

function publicQuestion(question) {
  return {
    id: question.id,
    groupID: question.groupID,
    index: question.index,
    status: question.status,
    mode: question.mode,
    sessionID: question.sessionID,
    agentID: question.agentID,
    text: question.text,
    priority: question.priority,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
    answer: question.answer,
    answerSource: question.answerSource,
    answeredByUserID: question.answeredByUserID,
    answeredByAgentID: question.answeredByAgentID,
    dismissalReason: question.dismissalReason,
    contextRefs: question.contextRefs,
    defaultAnswer: question.defaultAnswer,
    defaultDueAt: question.defaultDueAt,
    acknowledgedAt: question.acknowledgedAt,
    supersededDefaultAnswer: question.supersededDefaultAnswer,
    revisedAt: question.revisedAt,
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function normalizeRequiredString(value, field) {
  let text = normalizeOptionalString(value);
  if (!text)
    throw new TypeError(`${field} must be a non-empty string`);
  return text;
}
