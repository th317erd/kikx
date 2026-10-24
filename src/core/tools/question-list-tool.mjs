'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { resolveContextService } from './file-tool-cwd.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';
import { queryQuestions } from '../questions/question-query.mjs';

/**
 * Read the questions already pending in this session tree.
 *
 * This is the missing read half of `ask-user`, and it exists to answer the two
 * questions an agent genuinely cannot answer from memory: "what have I already
 * asked?" and "if I asked a set and only some were answered, what is left?".
 *
 * It is also the proof half of the ask precondition. `ask-user` refuses to write
 * unless it is handed the `openDigest` this tool returns, so the agent has to
 * look before it asks. The digest is content-addressed over the visible pending
 * set, which means it changes the instant anything in that set changes.
 *
 * Scope is the session and its descendants — never siblings or unrelated
 * sessions. That is both the privacy boundary and the reason the payload stays
 * small.
 */
export class QuestionListTool extends PluginInterface {
  static pluginID = 'internal:questions';
  static featureName = 'question-list';
  static displayName = 'List questions';
  static description = 'List/search questions with session-tree, status, text, agent, priority, group, and pagination filters. Returns an openDigest for the current session tree.';
  static frameType = 'QuestionListToolFrame';
  static clientComponent = builtInToolComponent('kikx-question-list-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Session to scope the listing to. Defaults to your current session.',
      },
      scope: {
        type: 'string',
        enum: [ 'tree', 'session', 'all' ],
        description: 'tree: session plus all descendants (default). session: this session only. all: every session; coordinator-only.',
      },
      status: {
        type: 'string',
        enum: [ 'open', 'answered', 'dismissed', 'undeliverable', 'all' ],
        description: 'Which questions to return. Defaults to open. Use all to review history.',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive text search over question, answer, dismissal reason, and context refs.',
      },
      agent_id: { type: 'string', description: 'Optional filter by asking agent id.' },
      priority: { type: 'string', enum: [ 'low', 'normal', 'high' ], description: 'Optional priority filter.' },
      group_id: { type: 'string', description: 'Optional question group id filter.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size (default 50).' },
      offset: { type: 'integer', minimum: 0, description: 'Result offset (default 0).' },
    },
    additionalProperties: false,
  };
  static help = [
    'Use question-list BEFORE ask-user. It returns the questions already pending',
    'in your session and its child sessions, plus an openDigest.',
    '',
    'ask-user refuses to run without that digest, and refuses again if the set',
    'changed since you looked. That is deliberate: it is the only reliable way to',
    'stop you from re-asking the user something they have already been asked,',
    'which is especially easy to do after a compaction or a restart when your own',
    'memory of the earlier question is gone.',
    '',
    'Each question carries its status and, once answered, the answer plus',
    'answerSource. A "default" answerSource means the answer is YOUR OWN',
    'fallback that timed out, not a decision the user made — do not present it as',
    'the user\'s choice.',
    '',
    'If a batch was only partially answered, this shows you exactly which ones are',
    'still open, so you can ask about those alone rather than the whole set again.',
    '',
    'Filters: use scope=session for only this session, scope=tree (default) for',
    'this session plus descendants, or scope=all (coordinator only) for every',
    'session. Use query to search question/answer text and context refs, and',
    'session_id to inspect another session tree.',
  ].join('\n');

  questionsStore() {
    let store = this.context.questionsStore
      || this.context.services?.questionsStore
      || resolveContextService(this.context, 'questionsStore');

    if (!store)
      throw new Error(`${this.constructor.featureName} requires questionsStore`);

    if (typeof store.listVisibleQuestions !== 'function')
      throw new Error(`${this.constructor.featureName} requires questionsStore.listVisibleQuestions`);

    return store;
  }

  // Questions are first-class references, exactly as ask-user treats them.
  static referencesFor(result = {}) {
    let questions = Array.isArray(result?.questions) ? result.questions : [];
    let references = [];

    for (let question of questions) {
      if (!question?.id)
        continue;

      references.push({
        type: 'question',
        id: question.id,
        label: question.text || question.id,
        sessionID: question.sessionID || null,
      });
    }

    return references.length > 0 ? references : null;
  }

  async _execute(params = {}) {
    let sessionID = normalizeOptionalString(
      params.session_id || params.sessionID || params._sessionID || this.context.session?.id,
    );
    let scope = normalizeOptionalString(params.scope) || 'tree';
    if (scope === 'all' && this.context.isCoordinator !== true)
      throw new Error('question-list scope=all is coordinator-only');
    if (scope !== 'all' && !sessionID)
      throw new Error(`${this.constructor.featureName} requires a session context`);

    return await queryQuestions(this.questionsStore(), {
      scope,
      sessionID,
      status: normalizeOptionalString(params.status) || 'open',
      query: normalizeOptionalString(params.query || params.q) || null,
      agentID: normalizeOptionalString(params.agent_id || params.agentID) || null,
      priority: normalizeOptionalString(params.priority) || null,
      groupID: normalizeOptionalString(params.group_id || params.groupID) || null,
      limit: params.limit,
      offset: params.offset,
    });
  }
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
