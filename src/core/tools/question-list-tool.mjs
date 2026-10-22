'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { resolveContextService } from './file-tool-cwd.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

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
  static description = 'List the questions already pending in this session and its child sessions, with an openDigest that ask-user requires before asking again.';
  static frameType = 'QuestionListToolFrame';
  static clientComponent = builtInToolComponent('kikx-question-list-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Session to scope the listing to. Defaults to your current session. Its child sessions are always included.',
      },
      status: {
        type: 'string',
        enum: [ 'open', 'answered', 'dismissed', 'undeliverable', 'all' ],
        description: 'Which questions to return. Defaults to open, which is the set you are deciding whether to re-ask. Use all to review history.',
      },
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
    if (!sessionID)
      throw new Error(`${this.constructor.featureName} requires a session context`);

    let listed = await this.questionsStore().listVisibleQuestions({
      sessionID,
      status: normalizeOptionalString(params.status) || 'open',
    });

    return {
      rootSessionID: listed.rootSessionID,
      sessionIDs: listed.sessionIDs,
      openDigest: listed.openDigest,
      total: listed.total,
      questions: listed.questions.map((question) => ({
        id: question.id,
        text: question.text,
        status: question.status,
        priority: question.priority,
        askedAt: question.askedAt ?? null,
        groupID: question.groupID ?? null,
        sessionID: question.sessionID ?? null,
        agentID: question.agentID ?? null,
        answer: question.answer ?? null,
        answerSource: question.answerSource ?? null,
        answeredAt: question.answeredAt ?? null,
        dismissalReason: question.dismissalReason ?? null,
      })),
    };
  }
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
