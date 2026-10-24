'use strict';

// Answer delivery: the "answer loop" half of the ask-user feature.
//
// The core requirement (plan §5): an answered question must WAKE the asking
// agent in the origin session, carrying enough context that a stale
// question/answer pair is still intelligible. Two modes, one mechanism:
//
//   mode:'wait'     - the asker already ended its turn; the answer starts a new one.
//   mode:'continue' - the asker is mid-turn; the answer is a live STEER.
//
// In both cases we post one visible, targeted `UserMessage` per answered
// question ([D-9]). `targetAgentID` is what makes it wake exactly one agent:
// `resolveRouteTargets()` short-circuits to a single-target bypass when the
// target is a participant.
//
// The continuation kind is `user-answer`, which is deliberately NOT in
// `AUTONOMOUS_CONTINUATION_KINDS`. That matters: `cancelAutonomousWakes()` only
// cancels autonomous continuations, so a human answer can never be retired as
// chatter, and an answer is never chain-capped. A human outranks the bot's own
// scheduling.

import { reviseAnswer } from './question-answer-revision.mjs';
import { patchQuestionFrameContent } from './question-frame-patch.mjs';
import { cancelQuestionSchedule } from './question-deadline-schedule.mjs';
import { isWakeSuppressed } from './question-fields.mjs';

const ANSWER_AUTHOR_FALLBACK = 'user';

/**
 * Raised when the answer was stored but could not be delivered to the asking
 * agent (deleted, disabled, or no longer a participant). The answer is always
 * kept — a user reply must never be silently dropped.
 */
export class QuestionUndeliverableError extends Error {
  constructor(message, question = null) {
    super(message);
    this.name = 'QuestionUndeliverableError';
    this.code = 'QUESTION_UNDELIVERABLE';
    this.question = question;
  }
}

export class QuestionAnswerService {
  constructor(options = {}) {
    let {
      questionsStore,
      frameRuntime,
      agentManager = null,
      logger = console,
    } = options;

    if (!questionsStore)
      throw new TypeError('QuestionAnswerService requires questionsStore');
    if (!frameRuntime)
      throw new TypeError('QuestionAnswerService requires frameRuntime');

    this.questionsStore = questionsStore;
    this.frameRuntime = frameRuntime;
    this.agentManager = agentManager;
    this.logger = logger;
  }

  /**
   * Store an answer and deliver it to the asking agent.
   *
   * Ordering is deliberate: the answer is persisted FIRST, then delivery is
   * attempted. A crash between the two leaves an answered question with no
   * wake (recoverable, visible) rather than a wake referring to an answer that
   * was never stored.
   */
  async submitAnswer(questionID, input = {}) {
    let question = await this.questionsStore.getQuestion(questionID);

    // The store enforces terminal/409 itself, under a per-question mutex. It
    // also returns the stored doc, which is what we want to deliver.
    let answered = await this.questionsStore.answerQuestion(questionID, {
      answer: input.answer,
      userID: input.userID,
      answerFrameID: input.answerFrameID,
      wakeSuppressed: input.wakeSuppressed,
    });

    // Make the answered state visible where the question was asked. Without
    // this the stored `Question` frame stays frozen at `status:'open'` with no
    // answer, so every re-render of the thread put the empty form and its
    // Submit button back on a question that was already answered.
    // The question is answered, so its pending default-answer deadline must die
    // with it. Cancelling here is the primary guard against "the timer fired but
    // the question was already answered": the queue re-reads the frame on
    // dispatch and drops anything that is no longer `pending`. The fire-time
    // plugin re-checks the status as well, because dispatch() awaits between
    // choosing an entry and acting on it.
    try {
      await cancelQuestionSchedule({
        frameRuntime: this.frameRuntime,
        questionID: answered.id,
      });
    } catch (error) {
      this.logger?.warn?.('ask-user: could not cancel the default-answer deadline', error?.message || error);
    }

    await patchQuestionFrameContent({ frameRuntime: this.frameRuntime }, answered, {
      frameRuntime: this.frameRuntime,
    });

    // Wake suppression: the answer is stored and visible, but NO turn is started
    // for the asking agent. This is the "Dismiss" affordance in the Inbox — the
    // user declines to answer, and the agent is told so in writing wherever it
    // looks the question up, without being woken for the privilege.
    //
    // The return sits BEFORE `deliverAnswer` on purpose: the wake lives in that
    // one call, so skipping it makes "will not wake" structural instead of a
    // promise. Nothing downstream can re-deliver either — `findRetryableDeliveries`
    // only scans `status:'undeliverable'`, and this question stays `answered`.
    //
    // `question.answered` is still emitted: it carries no wake, only the runtime
    // event the client model listens to, so another tab's Inbox drops the row too.
    if (isWakeSuppressed(answered)) {
      this.emit('question.answered', {
        sessionID: question.sessionID,
        question: answered,
        frameID: null,
        wakeFrameID: null,
      });

      return {
        delivered: false,
        suppressed: true,
        question: answered,
        frameID: null,
        sessionID: question.sessionID,
        agentID: question.agentID,
      };
    }

    let delivery = await this.deliverAnswer(answered, input);

    if (!delivery.delivered) {
      let undeliverable = await this.questionsStore.markUndeliverable(questionID, {
        answer: answered.answer,
        userID: input.userID,
        reason: delivery.reason,
      });

      await patchQuestionFrameContent({ frameRuntime: this.frameRuntime }, undeliverable, {
        frameRuntime: this.frameRuntime,
      });

      this.emit('question.updated', {
        sessionID: question.sessionID,
        question: undeliverable,
        reason: delivery.reason,
      });

      return {
        delivered: false,
        reason: delivery.reason,
        question: undeliverable,
      };
    }

    // Routed but not yet picked up is not a failure. The answer is stored and
    // the wake is queued; saying "sent" would overclaim, and treating it as
    // undeliverable would schedule a retry for a message that is about to run.
    if (delivery.wakePending) {
      this.emit('question.updated', {
        sessionID: question.sessionID,
        question: delivery.question || answered,
        reason: 'delivery-pending',
      });

      return {
        delivered: false,
        pending: true,
        reason: 'delivery-pending',
        question: delivery.question || answered,
        frameID: delivery.frameID,
        sessionID: question.sessionID,
        agentID: question.agentID,
      };
    }

    this.emit('question.answered', {
      sessionID: question.sessionID,
      question: delivery.question || answered,
      frameID: delivery.frameID,
      wakeFrameID: delivery.frameID,
    });

    return {
      delivered: true,
      question: delivery.question || answered,
      frameID: delivery.frameID,
      sessionID: question.sessionID,
      agentID: question.agentID,
    };
  }

  /**
   * Replace a fired default with the user's real answer, and deliver it.
   *
   * This is the counterpart to `submitAnswer`, for the one state that method
   * refuses on purpose: a question whose answer came from a DEFAULT. The agent
   * has already been woken with "declined to say" and may have acted on it, so
   * a revision is not silent — it posts a second, clearly-labelled UserMessage.
   * Without that second wake the agent keeps a stale assumption forever, which
   * is the failure this whole path exists to correct.
   *
   * Returns `{ revised:false, reason, question }` when there is nothing to
   * revise. That is a normal "too late, a person already answered" outcome, the
   * same way `applyDefaultAnswer` treats "the user got there first"; only
   * malformed input or a missing question throws.
   */
  async reviseDefaultAnswer(questionID, input = {}) {
    let result = await reviseAnswer(this.questionsStore, questionID, {
      answer: input.answer,
      userID: input.userID,
      answerFrameID: input.answerFrameID,
      now: input.now,
    });

    if (!result.revised)
      return { ...result, delivered: false, pending: false, suppressed: false, frameID: null };

    let revised = result.question;

    // Same order as submitAnswer: durability first, then visibility, then the
    // wake. A crash in between leaves a stored revision with no second wake,
    // which is recoverable and visible, rather than a wake about an answer that
    // was never stored.
    await patchQuestionFrameContent({ frameRuntime: this.frameRuntime }, revised, {
      frameRuntime: this.frameRuntime,
    });

    let delivery = await this.deliverAnswer(revised, input);

    if (!delivery.delivered) {
      // The revision itself is stored and correct; only the second wake failed.
      // Deliberately NOT markUndeliverable: that status exists for "the answer
      // never reached the agent", and demoting a good answer because the
      // correction could not be delivered would hide the answer as well.
      this.emit('question.answered', {
        sessionID: revised.sessionID,
        question: revised,
        frameID: null,
        wakeFrameID: null,
      });

      return {
        revised: true,
        question: revised,
        delivered: false,
        pending: false,
        suppressed: false,
        reason: delivery.reason,
        frameID: null,
        sessionID: revised.sessionID,
        agentID: revised.agentID,
      };
    }

    this.emit('question.answered', {
      sessionID: revised.sessionID,
      question: delivery.question || revised,
      frameID: delivery.frameID,
      wakeFrameID: delivery.frameID,
    });

    return {
      revised: true,
      question: delivery.question || revised,
      delivered: true,
      pending: false,
      suppressed: false,
      frameID: delivery.frameID,
      sessionID: revised.sessionID,
      agentID: revised.agentID,
    };
  }

  /**
   * Post the wake for an already-answered question. Never throws for an
   * undeliverable target: returns `{ delivered:false, reason }` so the caller
   * can record the state without losing the answer.
   */
  async deliverAnswer(question, input = {}) {
    let sessionID = question.sessionID;
    let agentID = question.agentID;

    let entry = null;
    try {
      entry = await this.frameRuntime.ensureSessionEntry(sessionID);
    } catch (error) {
      if (error?.status === 404)
        return { delivered: false, reason: 'origin-session-missing' };
      throw error;
    }

    if (!entry?.session || entry.session.deletedAt)
      return { delivered: false, reason: 'origin-session-deleted' };

    let participants = Array.isArray(entry.session.participantAgentIDs)
      ? entry.session.participantAgentIDs
      : [];

    if (!participants.includes(agentID))
      return { delivered: false, reason: 'agent-not-participant' };

    if (await this.isAgentUnavailable(agentID))
      return { delivered: false, reason: 'agent-unavailable' };

    let group = null;
    try {
      group = await this.questionsStore.getGroup(question.groupID);
    } catch (error) {
      // A missing group is not fatal: the wake still carries the question.
      this.logger?.warn?.('ask-user: group context unavailable', error?.message || error);
      group = null;
    }

    let now = this.clock();
    let frameID = this.idGenerator();
    let context = {
      text: buildAnswerPromptText(question, group),
      status: 'answered',
      question: {
        id: question.id,
        text: question.text,
        answer: question.answer,
        askedAt: question.askedAt,
        answeredAt: question.answeredAt,
        mode: question.mode,
        status: question.status,
        contextRefs: Array.isArray(question.contextRefs) ? question.contextRefs : [],
        group: group
          ? {
            id: group.id,
            index: question.index,
            total: group.total,
            siblings: group.siblings,
          }
          : null,
      },
      references: buildReferences(question),
    };

    // `appendUserMessage` owns the live-steer behaviour (it cancels pending
    // autonomous wakes so human authority supersedes the bot's own schedule),
    // so both modes route through it rather than merging directly.
    let result = await this.frameRuntime.appendUserMessage(sessionID, {
      id: frameID,
      userID: input.userID || question.answeredByUserID || null,
      authorDisplayName: input.authorDisplayName || null,
      targetAgentID: agentID,
      parentID: question.frameID || null,
      interactionID: `question:${question.id}`,
      content: context,
      continuation: {
        kind: 'user-answer',
        questionID: question.id,
        groupID: question.groupID,
        askedAt: question.askedAt,
        answeredAt: question.answeredAt,
        mode: question.mode || 'wait',
        createdAt: now,
      },
      timestamp: now,
      flushRouter: input.flushRouter !== false,
    });

    // Stored answer must be durable before we report success: otherwise a crash
    // after the wake could surface an answer the store never recorded.
    //
    // The runtime barrier settles the frame store *and* the router queue, so
    // 'answered' also implies 'routed'. It is deliberately asked NOT to wait for
    // background agent work: the wake starts a turn, and awaiting that turned a
    // POST that stores a short string into a request that hung for the whole of
    // the agent's reply (the user watched "Sending…" for minutes). Whether the
    // agent has actually picked the message up is reported separately, below.
    //
    // The store-only fallback keeps older runtimes working; a store flush alone
    // can leave the answer persisted but never routed, which is the gap this
    // service exists to close.
    if (input.flushRouter !== false) {
      if (typeof this.frameRuntime.flush === 'function')
        await this.frameRuntime.flush({ background: false });
      else
        await this.frameRuntime.frameStore?.flush?.();
    }

    return {
      delivered: true,
      // Durable and routed, but the agent's turn has not started yet.
      wakePending: result?.wakePending === true,
      frameID: result?.frame?.id || frameID,
      question,
    };
  }

  /**
   * A deleted or disabled agent cannot receive a wake. `agentManager` is
   * optional so tests and embedders can run without one.
   */
  async isAgentUnavailable(agentID) {
    if (!this.agentManager?.getAgent)
      return false;

    try {
      let agent = await this.agentManager.getAgent(agentID);
      if (!agent)
        return true;
      return agent.enabled === false || agent.deleted === true;
    } catch (error) {
      if (error?.status === 404)
        return true;
      throw error;
    }
  }

  emit(type, payload) {
    try {
      this.frameRuntime?.emitRuntimeEvent?.(type, payload);
    } catch (error) {
      this.logger?.warn?.(`ask-user: failed to emit ${type}`, error?.message || error);
    }
  }

  clock() {
    return Number(this.frameRuntime?.clock?.() || Date.now());
  }

  idGenerator() {
    return this.frameRuntime?.idGenerator?.() || `q-${Math.random().toString(16).slice(2)}`;
  }
}

/**
 * Human-readable wake text. It has to stand on its own: the answer may arrive
 * long after the question, and the model sees this text before any tool call.
 */
export function buildAnswerPromptText(question, group = null) {
  let lines = [];

  // A revision is the ONE case where a human answer replaces an answer the
  // agent already received. The agent may have acted on the default, so the
  // prompt has to say both things: a person did answer, and what it replaced.
  let superseded = typeof question.supersededDefaultAnswer === 'string'
    ? question.supersededDefaultAnswer
    : null;

  let age = describeAge(question.askedAt, question.answeredAt);
  let asked = age ? ` (you asked ${age})` : '';

  // A default is the agent's own fallback firing, not a human reply. Saying so
  // plainly is the difference between "the user decided" and "nobody answered,
  // so your own default took effect" — a model must not conflate those.
  if (superseded !== null) {
    lines.push(`The user answered your question${asked}, replacing the default you specified:`);
    lines.push('');
    lines.push(`Your default was: ${superseded}`);
    lines.push('A person has now given a real answer. It supersedes the default.');
  } else if (question.answerSource === 'default') {
    lines.push(`No answer arrived in time, so the default you specified was applied${asked}:`);
  } else {
    lines.push(`The user answered your question${asked}:`);
  }
  lines.push('');
  lines.push(`Q: ${question.text}`);
  lines.push(`A: ${question.answer || '(no text)'}`);

  if (group && group.total > 1) {
    let answered = group.siblings.filter((sibling) => sibling.status !== 'open').length;
    lines.push('');
    lines.push(`Batch context: ${answered} of ${group.total} answered.`);

    for (let sibling of group.siblings) {
      if (sibling.id === question.id)
        continue;

      let state = sibling.status === 'open'
        ? 'still waiting on you'
        : sibling.status;
      lines.push(`- ${sibling.text} — ${state}`);
    }
  }

  if (Array.isArray(question.contextRefs) && question.contextRefs.length > 0) {
    lines.push('');
    lines.push('References from when you asked:');
    for (let ref of question.contextRefs.slice(0, 10)) {
      lines.push(`- ${describeReference(ref)}`);
    }
  }

  if (superseded !== null) {
    lines.push('');
    lines.push('If you already acted on the default, that assumption was wrong and should be corrected.');
  } else if (question.answerSource === 'default') {
    lines.push('');
    lines.push('Nobody confirmed this. Treat it as your own assumption, and say so if you act on it.');
  } else if (question.mode === 'continue') {
    lines.push('');
    lines.push('This answer arrived while you were working and supersedes it — treat it as the current instruction.');
  } else {
    lines.push('');
    lines.push('Continue from here.');
  }

  return lines.join('\n');
}

function describeReference(ref) {
  if (!ref || typeof ref !== 'object')
    return String(ref);

  let type = ref.type || 'reference';
  let id = ref.id || ref.frameID || ref.path || '';
  let label = ref.label || ref.title || ref.text || '';

  if (label)
    return `${type} ${id}${id ? ': ' : ''}${truncate(label, 120)}`;

  return `${type} ${id}`.trim();
}

function buildReferences(question) {
  let refs = [];
  refs.push({ type: 'question', id: question.id });

  if (question.frameID)
    refs.push({ type: 'frame', id: question.frameID });

  for (let ref of Array.isArray(question.contextRefs) ? question.contextRefs : []) {
    if (ref && typeof ref === 'object')
      refs.push(ref);
    else
      refs.push({ type: 'reference', id: String(ref) });
  }

  for (let todoID of Array.isArray(question.todoIDs) ? question.todoIDs : [])
    refs.push({ type: 'todo', id: todoID });

  return refs;
}

function describeAge(askedAt, answeredAt) {
  let start = Number(askedAt);
  let end = Number(answeredAt);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return '';

  let seconds = Math.round((end - start) / 1000);
  if (seconds < 60)
    return `${seconds}s ago`;
  if (seconds < 3600)
    return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400)
    return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function truncate(value, max) {
  let text = String(value);
  if (text.length <= max)
    return text;
  return `${text.slice(0, max - 1)}…`;
}

export { ANSWER_AUTHOR_FALLBACK };
