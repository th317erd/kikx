'use strict';

import { PluginInterface } from '../plugins/index.mjs';

const DEFAULT_MAX_QUESTIONS = 25;

/**
 * Ask the user one or more questions.
 *
 * The tool is deliberately always-async: it persists the questions and returns
 * immediately with a pending status. It never blocks, polls, or returns an
 * answer. The answer arrives later as a wake (see the P2 answer loop): an
 * in-flight turn is steered, a resting agent is woken, and both carry the full
 * question context.
 *
 * Answers are free-form by decision D-4, so there is no `options` field. The
 * cap is an anti-spam guardrail (D-8), not a feature envelope.
 */
export class AskUserTool extends PluginInterface {
  static pluginID = 'internal:questions';
  static featureName = 'ask-user';
  static displayName = 'Ask user';
  static description = 'Ask the user one or more questions and continue without waiting for the answer. Answers are free-form and arrive later as a wake.';
  static frameType = 'AskUserToolFrame';
  // Like the todo tools: asking a question needs no permission prompt.
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask the user. Each answer is free-form text; there are no preset options.',
        minItems: 1,
        maxItems: DEFAULT_MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The question, phrased so it is answerable in plain prose.',
            },
            priority: {
              type: 'string',
              enum: [ 'low', 'normal', 'high' ],
              description: 'How much the answer matters for unblocking your work. Defaults to normal.',
            },
            defaultAnswer: {
              type: 'string',
              description: 'Optional acceptable fallback. If the user has not answered within timeoutSeconds, this is applied so you are not blocked forever. It is recorded as YOUR assumption, never as a user answer — say so if you act on it.',
            },
            timeoutSeconds: {
              type: 'number',
              description: 'Seconds after which defaultAnswer is applied. Only meaningful together with defaultAnswer. Leave unset to wait indefinitely.',
            },
            contextRefs: {
              type: 'array',
              description: 'References that give the question its frame of reference, such as a session, frame, todo, or file.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', description: 'Reference type, e.g. session, frame, todo, file.' },
                  id: { type: 'string', description: 'Reference identifier.' },
                  label: { type: 'string', description: 'Human-readable label.' },
                },
                required: [ 'type', 'id' ],
                additionalProperties: true,
              },
            },
          },
          required: [ 'text' ],
          additionalProperties: false,
        },
      },
      mode: {
        type: 'string',
        enum: [ 'wait', 'continue' ],
        description: 'wait: you are ending your turn and the answer starts your next one. continue: you keep working and the answer steers you mid-turn. Defaults to wait.',
      },
      note: {
        type: 'string',
        description: 'Optional short note explaining why you are asking.',
      },
      session_id: {
        type: 'string',
        description: 'Optional session to address the question to. Defaults to the current session.',
      },
    },
    required: [ 'questions' ],
    additionalProperties: false,
  };
  static help = 'Use ask-user when only the user can decide something: naming, priorities, ambiguous requirements, or a judgment call with real trade-offs. Ask everything you need in one call rather than a series of turns. Do not ask a question you can answer yourself by reading the code or docs. Never block waiting for the answer: ask, then continue with other work or end your turn. If a sensible fallback exists and waiting forever would stall you, pass defaultAnswer with a timeoutSeconds: the fallback is applied when the deadline passes and arrives marked as your own assumption, not as a user decision.';

  questionsStore() {
    let store = this.context.questionsStore
      || this.context.services?.questionsStore
      || resolveContextService(this.context, 'questionsStore');

    if (!store)
      throw new Error(`${this.constructor.featureName} requires questionsStore`);

    return store;
  }

  // A question is a first-class reference: clicking the result can open it in
  // the Inbox. The only contract is { type, id }.
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
    let agentID = normalizeOptionalString(this.context.agent?.id || params._agentID);
    if (!agentID)
      throw new Error(`${this.constructor.featureName} requires an agent context`);

    let sessionID = normalizeOptionalString(
      params.session_id || params.sessionID || params._sessionID || this.context.session?.id,
    );
    if (!sessionID)
      throw new Error(`${this.constructor.featureName} requires a session context`);

    let result = await this.questionsStore().createQuestions({
      questions: params.questions,
      mode: params.mode,
      note: params.note,
      sessionID,
      agentID,
      interactionID: this.context.frame?.interactionID || this.context.interactionID || null,
      // `frameID` is reserved for the emitted Question frame (set below);
      // the frame the tool was called from is the tool-call frame.
      toolCallFrameID: params._frameID || this.context.frame?.id || null,
      contextRefs: collectQuestionContextRefs(params.questions),
      focusAtAsk: this.context.todoState?.focus?.name || null,
      todoIDs: collectFocusTodoIDs(this.context.todoState),
    });

    await this.emitQuestionFrames({ result, sessionID, agentID });
    // Runtime event so clients can refresh an Inbox without polling. Emitted
    // after persistence and frame emission: the event is a notification, never
    // the source of truth, so a failure here must not fail the tool call.
    this.emitQuestionEvent('question.asked', {
      sessionID,
      agentID,
      groupID: result.groupID,
      questionIDs: result.questionIDs,
      questions: result.questions.map((question) => ({
        id: question.id,
        text: question.text,
        priority: question.priority,
        status: question.status,
        mode: question.mode,
        askedAt: question.askedAt,
        sessionID: question.sessionID,
        agentID: question.agentID,
      })),
    });

    return {
      groupID: result.groupID,
      questionIDs: result.questionIDs,
      status: result.status,
      mode: result.mode,
      message: result.message,
      questions: result.questions.map((question) => ({
        id: question.id,
        text: question.text,
        priority: question.priority,
        sessionID: question.sessionID,
        contextRefs: question.contextRefs,
      })),
    };
  }

  /**
   * Fire a runtime event if the runtime exposes the channel. Best-effort: the
   * store is the source of truth and events are only a UI refresh hint.
   */
  emitQuestionEvent(type, payload) {
    let runtime = this.context?.services?.frameRuntime
      || this.context?.frameRuntime
      || null;

    try {
      runtime?.emitRuntimeEvent?.(type, payload);
    } catch (error) {
      this.context?.logger?.warn?.(`ask-user: failed to emit ${type}`, error?.message || error);
    }
  }
  /**
   * Emit one `Question` frame per question (D-3: one frame per question, tied by
   * groupID). Registration of the client renderer is P3; an unregistered frame
   * type renders through the fallback, so emitting here is safe in P1.
   */
  async emitQuestionFrames({ result, sessionID, agentID }) {
    let frameEngine = resolveFrameEngine(this.context);
    if (!frameEngine || typeof frameEngine.merge !== 'function')
      return;

    let stamps = [];
    for (let question of result.questions) {
      let now = resolveClock(this.context)();
      let frame = {
        id: frameEngine.idGenerator?.() || `question:${question.id}`,
        type: 'Question',
        sessionID,
        interactionID: question.interactionID || this.context.frame?.interactionID || null,
        parentID: this.context.frame?.id || null,
        authorType: 'agent',
        authorID: agentID,
        authorDisplayName: this.context.agent?.name || agentID,
        timestamp: now,
        createdAt: now,
        updatedAt: now,
        hidden: false,
        deleted: false,
        content: {
          questionID: question.id,
          groupID: question.groupID,
          index: question.index,
          text: question.text,
          priority: question.priority,
          mode: question.mode,
          status: 'open',
          contextRefs: question.contextRefs,
          askedAt: question.askedAt,
        },
      };

      let merged = frameEngine.merge([ frame ], {
        authorType: 'agent',
        authorID: agentID,
      });
      let frameID = merged?.[0]?.id || frame.id;
      stamps.push({ questionID: question.id, frameID });

      await this.questionsStore().attachQuestionFrame(question.id, frameID);
    }

    await flushFrameStore(this.context);
    return stamps;
  }
}

export const ASK_USER_MAX_QUESTIONS = DEFAULT_MAX_QUESTIONS;

function collectQuestionContextRefs(questions) {
  if (!Array.isArray(questions))
    return [];

  let refs = [];
  let seen = new Set();
  for (let question of questions) {
    if (!Array.isArray(question?.contextRefs))
      continue;

    for (let ref of question.contextRefs) {
      if (!ref || typeof ref !== 'object')
        continue;

      let type = normalizeOptionalString(ref.type);
      let id = normalizeOptionalString(ref.id);
      if (!type || !id)
        continue;

      let key = `${type}:${id}`;
      if (seen.has(key))
        continue;

      seen.add(key);
      refs.push(ref);
    }
  }

  return refs;
}

function collectFocusTodoIDs(todoState) {
  let focus = todoState?.focus;
  if (!focus)
    return [];

  let ids = [];
  if (focus.itemID)
    ids.push(focus.itemID);

  if (focus.childID)
    ids.push(focus.childID);

  return ids;
}

function resolveFrameEngine(context = {}) {
  if (context.frameEngine)
    return context.frameEngine;

  if (context.services?.frameEngine)
    return context.services.frameEngine;

  return null;
}

function resolveClock(context = {}) {
  if (typeof context.clock === 'function')
    return context.clock;

  if (typeof context.services?.clock === 'function')
    return context.services.clock;

  return () => Date.now();
}

async function flushFrameStore(context = {}) {
  let store = context.frameStore
    || context.services?.frameStore
    || resolveContextService(context, 'frameStore');

  if (typeof store?.flush === 'function')
    await store.flush();
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
