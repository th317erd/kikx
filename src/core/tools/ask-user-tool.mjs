'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import {
  assertAskPrecondition,
  findDuplicateQuestions,
} from '../questions/question-dedupe.mjs';
import { normalizeQuestionList } from '../questions/question-doc.mjs';
import { armQuestionDeadline } from '../questions/question-deadline-schedule.mjs';

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
  static description = 'Ask the user one or more free-form questions. Answers arrive later as a wake. mode \'wait\' ends your turn and the answer starts your next one; mode \'continue\' keeps you working and the answer steers you mid-task.';
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
        description: "wait (default): you cannot continue without the answer, so you end your turn and the answer starts your next one. continue: you have independent work, so you keep working and the answer steers you mid-flight. Pick by what you can do next, and match it to how you end the turn.",
      },
      note: {
        type: 'string',
        description: 'Optional short note explaining why you are asking.',
      },
      session_id: {
        type: 'string',
        description: 'Optional session to address the question to. Defaults to the current session.',
      },
      observedQuestionDigest: {
        type: 'string',
        description: 'The openDigest returned by question-list. Required: it proves you checked what is already pending before asking, so you do not duplicate a question. The call is refused if the pending set changed since you looked.',
      },
    },
    required: [ 'questions', 'observedQuestionDigest' ],
    additionalProperties: false,
  };
  static help = [
    'LOOK FIRST. Before asking, call question-list. It returns the questions',
    'already pending in this session and its child sessions, plus an openDigest.',
    'Pass that openDigest as observedQuestionDigest. ask-user refuses to run',
    'without it, refuses if the pending set changed since you looked, and refuses',
    'to ask anything that duplicates a question already pending. This exists',
    'because re-asking something the user has already been asked is a real and',
    'repeated failure, especially after a compaction or restart. If a batch was',
    'only partially answered, question-list shows which ones are still open — ask',
    'about those, not the whole set again.',
    '',
    'Use ask-user only when the user must decide: naming, priorities, scope,',
    'ambiguous requirements, or a judgment call with real trade-offs. Ask only',
    'when missing knowledge or authority materially changes the next action;',
    'existing authorization remains valid. Do not ask what you can settle yourself',
    'by reading the code or docs, and do not hand routine progress back as a',
    'question. Ask everything you need in ONE call rather than a series of turns.',
    '',
    'Choosing mode is the part agents get wrong. Decide by what you can do next:',
    "  mode 'wait' (default) — you cannot proceed without the answer. Call",
    '    ask-user, then END YOUR TURN with end-turn. The answer starts your next',
    '    turn as a steering prompt. This is the right choice when everything',
    '    remaining depends on the reply.',
    "  mode 'continue' — you have independent work to do meanwhile. Call ask-user,",
    '    then KEEP WORKING (continue-turn). The answer arrives mid-flight as a',
    '    steering prompt and you adjust. Use this when the answer is not urgent.',
    'Do not ask in wait mode and then keep working: that leaves the user waiting on',
    'a turn that already ended, or the answer steering nothing.',
    '',
    'If a sensible fallback exists and waiting forever would stall you, pass',
    'defaultAnswer together with timeoutSeconds. When the deadline passes the',
    'fallback is applied and arrives marked as YOUR OWN ASSUMPTION, never as a user',
    'decision — so state that assumption if you act on it.',
  ].join('\n');

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

    // Validate the payload BEFORE the precondition. A malformed call should be
    // told what is malformed, not told to go read question-list first; the
    // store validates again on write, which is cheap and keeps one authority.
    normalizeQuestionList(params.questions);

    // Look-before-you-write. Recomputed here from the same source question-list
    // reads, so a digest copied without reading (or replayed after the set
    // moved) cannot satisfy it.
    let visible = await this.questionsStore().listVisibleQuestions({ sessionID, status: 'open' });
    let duplicates = findDuplicateQuestions({
      summaries: visible.questions,
      questions: params.questions,
    });

    assertAskPrecondition({
      sessionID,
      expectedDigest: params.observedQuestionDigest,
      actualDigest: visible.openDigest,
      duplicates,
    });

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
      // Deliberately NOT setting a batch-level `contextRefs`: the schema puts
      // this field inside each question, and the store reads it from there.
      // Passing a union here is what silently copied one question's references
      // onto every sibling in the batch.
      focusAtAsk: this.context.todoState?.focus?.name || null,
      todoIDs: collectFocusTodoIDs(this.context.todoState),
    });

    await this.emitQuestionFrames({ result, sessionID, agentID });

    // Arm each question's default-answer deadline on the generic scheduled-frame
    // queue. Doing it here (not on a timer) is what makes the deadline O(1) per
    // question and durable across a restart. A failure to arm must not fail the
    // ask: the question is already persisted, and the fire-time plugin re-reads
    // it, so the worst case is a default that never fires rather than an error.
    await this.armDeadlines(result);
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
  async armDeadlines(result) {
    let frameRuntime = this.context?.services?.frameRuntime || this.context?.frameRuntime || null;
    if (!frameRuntime?.ensureSessionEntry)
      return;

    for (let question of result.questions || []) {
      if (question.defaultDueAt == null)
        continue;

      try {
        await armQuestionDeadline({ frameRuntime, question });
      } catch (error) {
        this.context?.services?.logger?.warn?.(
          'ask-user: could not arm the default-answer deadline',
          error?.message || error,
        );
      }
    }
  }

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
          // `id` is the canonical row key the client normalizer reads.
          // `questionID` is kept beside it because stored frames and the
          // attachQuestionFrame stamps already use that name.
          id: question.id,
          questionID: question.id,
          sessionID: question.sessionID,
          agentID: question.agentID,
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
