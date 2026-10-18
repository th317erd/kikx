'use strict';

import { randomUUID } from 'node:crypto';

const DEFAULT_ROOT_PATH = '/kikx';
const MAX_QUESTIONS_PER_CALL = 25;
const STATUSES = [ 'open', 'answered', 'dismissed', 'undeliverable' ];
const TERMINAL_STATUSES = [ 'answered', 'dismissed', 'undeliverable' ];
const PRIORITIES = [ 'low', 'normal', 'high' ];
const MODES = [ 'wait', 'continue' ];

/**
 * Persistence for ask-user questions.
 *
 * Truth lives in one immutable doc per question under `<root>/questions/<id>.json`,
 * mirroring AgentTodoStore's per-agent todo doc. Two derived indexes sit on top:
 * a global open index and a per-agent mirror. Indexes are caches — `reindex()`
 * rebuilds them from the per-question docs — so a lost index is never data loss.
 *
 * The shape is free-form by decision D-4: there is deliberately no `options`
 * field. The cap is an anti-spam guardrail (D-8), not a feature envelope.
 */
export class QuestionsStore {
  constructor(options = {}) {
    let db = options.db || options.aeordb;
    let {
      rootPath = DEFAULT_ROOT_PATH,
      clock = () => Date.now(),
      idGenerator = () => randomUUID(),
    } = options;

    if (!db)
      throw new TypeError('QuestionsStore requires db (or the aeordb alias)');

    this.aeordb = db;
    this.db = db;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
    this.idGenerator = idGenerator;
    // AeorDB has no conditional write, so idempotency depends on serialising
    // read-modify-write per question inside this single process.
    this.locks = new Map();
  }

  /**
   * Persist a batch of questions as one group and return immediately with the
   * status. This never blocks, polls, or waits for an answer.
   */
  async createQuestions(input = {}) {
    let questions = normalizeQuestionList(input.questions);
    let mode = normalizeMode(input.mode);
    let sessionID = normalizeRequiredString(input.sessionID || input.session_id, 'sessionID');
    let agentID = normalizeRequiredString(input.agentID || input.agent_id, 'agentID');
    let contextRefs = normalizeContextRefs(input.contextRefs || input.context_refs);
    let note = normalizeOptionalString(input.note);
    let groupID = this.idGenerator();
    let now = this.clock();
    let created = [];

    for (let [ offset, entry ] of questions.entries()) {
      let question = {
        id: this.idGenerator(),
        groupID,
        index: offset + 1,
        status: 'open',
        mode,
        sessionID,
        agentID,
        interactionID: normalizeOptionalString(input.interactionID || input.interaction_id) || null,
        frameID: normalizeOptionalString(input.frameID || input.frame_id) || null,
        toolCallFrameID: normalizeOptionalString(input.toolCallFrameID || input.tool_call_frame_id) || null,
        toolOutputID: normalizeOptionalString(input.toolOutputID || input.tool_output_id) || null,
        todoIDs: Array.isArray(input.todoIDs) ? input.todoIDs.map((id) => String(id)) : [],
        focusAtAsk: normalizeOptionalString(input.focusAtAsk || input.focus_at_ask) || null,
        contextRefs,
        text: entry.text,
        priority: entry.priority,
        answer: null,
        answeredAt: null,
        answeredClock: null,
        answeredByUserID: null,
        answerFrameID: null,
        dismissalReason: null,
        askedAt: now + offset,
        askedClock: null,
        createdAt: now + offset,
        updatedAt: now + offset,
        readAt: null,
        deleted: false,
      };

      await this.aeordb.putFile(this.questionPath(question.id), question);
      created.push(question);
    }

    await this.writeIndexes(created.map((question) => question.id), []);

    return {
      groupID,
      questionIDs: created.map((question) => question.id),
      status: 'pending',
      mode,
      note: note || null,
      message: created.length === 1
        ? 'Question asked and pending until answered. Do not block waiting for the answer; continue with other work or end your turn.'
        : `${created.length} questions asked and pending until answered. Do not block waiting for answers; continue with other work or end your turn.`,
      questions: created.map(cloneJSON),
    };
  }

  async getQuestion(questionID) {
    let id = normalizeRequiredString(questionID, 'questionID');
    let doc = null;

    try {
      doc = await this.aeordb.getFile(this.questionPath(id));
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }

    let question = normalizeQuestionDoc(doc);
    if (!question)
      throw notFound(`Question not found: ${id}`);

    return question;
  }

  /**
   * Record an answer. Idempotent: a second answer on a terminal question is a
   * 409 and writes nothing. Serialised per question by an in-process mutex so
   * two concurrent POSTs cannot both pass the terminal check.
   */
  async answerQuestion(questionID, input = {}) {
    let id = normalizeRequiredString(questionID, 'questionID');
    let answer = normalizeAnswerText(input.answer);

    return await this.withLock(id, async () => {
      let question = await this.getQuestion(id);
      assertOpen(question, 'answered');

      let now = this.clock();
      let updated = {
        ...question,
        status: 'answered',
        answer,
        answeredAt: now,
        answeredByUserID: normalizeOptionalString(input.userID || input.user_id) || null,
        answerFrameID: normalizeOptionalString(input.answerFrameID || input.answer_frame_id) || null,
        updatedAt: now,
      };

      await this.aeordb.putFile(this.questionPath(id), updated);
      await this.writeIndexes([ id ], [ question.agentID ]);

      return cloneJSON(updated);
    });
  }

  /**
   * Record an answer that could not be delivered to the asking agent. The answer
   * is always kept: a user answer must never be silently dropped.
   */
  async markUndeliverable(questionID, input = {}) {
    let id = normalizeRequiredString(questionID, 'questionID');
    let answer = normalizeOptionalString(input.answer) || null;

    return await this.withLock(id, async () => {
      let question = await this.getQuestion(id);
      assertCanMarkUndeliverable(question);

      let now = this.clock();
      let reason = normalizeOptionalString(input.reason) || 'undeliverable';
      let updated = {
        ...question,
        status: 'undeliverable',
        answer: answer ?? question.answer,
        // The answer was recorded before delivery was attempted, so its stamps
        // already exist; keep them rather than restating them as the failure time.
        answeredAt: question.answeredAt ?? now,
        answeredByUserID: normalizeOptionalString(input.userID || input.user_id) || question.answeredByUserID || null,
        deliveryFailedAt: now,
        deliveryFailureReason: reason,
        dismissalReason: reason,
        updatedAt: now,
      };

      await this.aeordb.putFile(this.questionPath(id), updated);
      await this.writeIndexes([ id ], [ question.agentID ]);

      return cloneJSON(updated);
    });
  }

  async dismissQuestion(questionID, input = {}) {
    let id = normalizeRequiredString(questionID, 'questionID');

    return await this.withLock(id, async () => {
      let question = await this.getQuestion(id);
      assertOpen(question, 'dismissed');

      let now = this.clock();
      let updated = {
        ...question,
        status: 'dismissed',
        dismissalReason: normalizeOptionalString(input.reason) || null,
        updatedAt: now,
      };

      await this.aeordb.putFile(this.questionPath(id), updated);
      await this.writeIndexes([ id ], [ question.agentID ]);

      return cloneJSON(updated);
    });
  }

  /**
   * Record the id of the `Question` frame that renders this question, so the UI
   * can reconcile a stored question with its transcript frame.
   */
  async attachQuestionFrame(questionID, frameID) {
    let id = normalizeRequiredString(questionID, 'questionID');
    let frame = normalizeRequiredString(frameID, 'frameID');

    return await this.withLock(id, async () => {
      let question = await this.getQuestion(id);
      if (question.frameID)
        return cloneJSON(question);

      let updated = { ...question, frameID: frame, updatedAt: this.clock() };
      await this.aeordb.putFile(this.questionPath(id), updated);
      return cloneJSON(updated);
    });
  }

  async markRead(questionID) {
    let id = normalizeRequiredString(questionID, 'questionID');

    return await this.withLock(id, async () => {
      let question = await this.getQuestion(id);
      if (question.readAt)
        return cloneJSON(question);

      let now = this.clock();
      let updated = { ...question, readAt: now, updatedAt: now };
      await this.aeordb.putFile(this.questionPath(id), updated);
      return cloneJSON(updated);
    });
  }

  /**
   * Read the open index only. Callers that need to render a list must not scan
   * the per-question store; that is what the index is for.
   */
  async listOpen(filters = {}) {
    let index = await this.readOpenIndex();
    let summaries = Array.isArray(index.summaries) ? index.summaries : [];

    let sessionID = normalizeOptionalString(filters.sessionID || filters.session_id);
    let agentID = normalizeOptionalString(filters.agentID || filters.agent_id);
    let groupID = normalizeOptionalString(filters.groupID || filters.group_id);

    if (sessionID)
      summaries = summaries.filter((entry) => entry.sessionID === sessionID);

    if (agentID)
      summaries = summaries.filter((entry) => entry.agentID === agentID);

    if (groupID)
      summaries = summaries.filter((entry) => entry.groupID === groupID);

    return {
      ids: summaries.map((entry) => entry.id),
      summaries: summaries.map(cloneJSON),
      updatedAt: index.updatedAt || null,
    };
  }

  async listForAgent(agentID) {
    let id = normalizeRequiredString(agentID, 'agentID');
    let index = null;

    try {
      index = await this.aeordb.getFile(this.agentIndexPath(id));
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }

    return {
      agentID: id,
      ids: Array.isArray(index?.ids) ? [ ...index.ids ] : [],
      summaries: Array.isArray(index?.summaries) ? index.summaries.map(cloneJSON) : [],
      updatedAt: index?.updatedAt || null,
    };
  }

  /**
   * Group context for a wake payload (D-9): one wake per answered question, but
   * each carries the whole batch so the model can treat it as one flow.
   */
  async getGroup(groupID) {
    let id = normalizeRequiredString(groupID, 'groupID');
    let questionIDs = await this.listGroupIDs(id);
    let siblings = [];

    for (let questionID of questionIDs) {
      let question = await this.getQuestion(questionID);
      siblings.push({ id: question.id, text: question.text, status: question.status });
    }

    if (siblings.length === 0)
      throw notFound(`Question group not found: ${id}`);

    return {
      id,
      total: siblings.length,
      siblings,
    };
  }

  /**
   * Indexes are caches, never truth. Rebuild both from the per-question docs.
   */
  async reindex() {
    let { items } = await this.aeordb.list(`${this.rootPath}/questions`, { glob: '*.json' });
    let questions = [];
    let skipped = 0;

    for (let item of items) {
      let doc = null;
      try {
        doc = await this.aeordb.getFile(item.path);
      } catch (error) {
        if (error.status !== 404)
          throw error;

        skipped++;
        continue;
      }

      let question = normalizeQuestionDoc(doc);
      if (!question) {
        skipped++;
        continue;
      }

      questions.push(question);
    }

    questions.sort(compareQuestions);

    let priorAgents = await this.listAgentIndexAgentIDs();
    await this.writeIndexes(questions.map((question) => question.id), priorAgents);

    return {
      scanned: questions.length,
      skipped,
      openIDs: questions.filter((question) => question.status === 'open').map((question) => question.id),
    };
  }

  async listGroupIDs(groupID) {
    let { items } = await this.aeordb.list(`${this.rootPath}/questions`, { glob: '*.json' });
    let matches = [];

    for (let item of items) {
      let doc = null;
      try {
        doc = await this.aeordb.getFile(item.path);
      } catch (error) {
        if (error.status !== 404)
          throw error;

        continue;
      }

      let question = normalizeQuestionDoc(doc);
      if (question?.groupID === groupID)
        matches.push(question);
    }

    matches.sort(compareQuestions);
    return matches.map((question) => question.id);
  }

  /**
   * Serialise a read-modify-write on one key. Waiters queue on a gate that is
   * released in `finally`, so a throwing critical section cannot wedge the queue.
   */
  async withLock(key, fn) {
    let previous = this.locks.get(key) || Promise.resolve();
    let release = null;
    let gate = new Promise((resolve) => { release = resolve; });
    let chained = previous.then(() => gate);
    this.locks.set(key, chained);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained)
        this.locks.delete(key);
    }
  }

  async readOpenIndex() {
    try {
      let index = await this.aeordb.getFile(this.indexPath());
      return {
        ids: Array.isArray(index?.ids) ? index.ids.filter((id) => typeof id === 'string') : [],
        summaries: Array.isArray(index?.summaries) ? index.summaries : [],
        updatedAt: index?.updatedAt || null,
      };
    } catch (error) {
      if (error.status !== 404)
        throw error;

      return { ids: [], summaries: [], updatedAt: null };
    }
  }

  /**
   * Rewrite both indexes from the per-question docs. Every mutation funnels
   * through here so the open index and the per-agent mirrors cannot drift.
   *
   * `touchedAgentIDs` names agents whose mirror may need clearing once their
   * last open question closes; `extraAgentIDs` carries agents discovered without
   * a store scan (reindex).
   */
  async writeIndexes(questionIDs, touchedAgentIDs = [], extraAgentIDs = []) {
    let touched = [];
    for (let questionID of questionIDs) {
      let doc = null;
      try {
        doc = await this.aeordb.getFile(this.questionPath(questionID));
      } catch (error) {
        if (error.status !== 404)
          throw error;

        continue;
      }

      let question = normalizeQuestionDoc(doc);
      if (question)
        touched.push(question);
    }

    let existing = await this.readOpenIndex();
    let byID = new Map();
    for (let summary of existing.summaries) {
      if (summary?.id)
        byID.set(summary.id, summary);
    }

    for (let question of touched) {
      if (question.status === 'open')
        byID.set(question.id, summarizeQuestion(question));
      else
        byID.delete(question.id);
    }

    let summaries = [ ...byID.values() ].sort(compareSummaries);

    await this.aeordb.putFile(this.indexPath(), {
      ids: summaries.map((summary) => summary.id),
      summaries,
      updatedAt: this.clock(),
    });

    let agentIDs = new Set();
    for (let summary of summaries) {
      if (summary.agentID)
        agentIDs.add(summary.agentID);
    }

    for (let agentID of touchedAgentIDs) {
      if (agentID)
        agentIDs.add(agentID);
    }

    for (let agentID of extraAgentIDs) {
      if (agentID)
        agentIDs.add(agentID);
    }

    for (let agentID of agentIDs) {
      let owned = summaries.filter((summary) => summary.agentID === agentID);
      await this.aeordb.putFile(this.agentIndexPath(agentID), {
        agentID,
        ids: owned.map((summary) => summary.id),
        summaries: owned.map(cloneJSON),
        updatedAt: this.clock(),
      });
    }
  }

  async listAgentIndexAgentIDs() {
    let { items } = await this.aeordb.list(`${this.rootPath}/agents`, { recursive: true, glob: 'questions.json' });
    let agentIDs = [];

    for (let item of items) {
      let match = /\/([^/]+)\/questions\.json$/.exec(item.path);
      if (match)
        agentIDs.push(decodeURIComponent(match[1]));
    }

    return agentIDs;
  }

  questionPath(questionID) {
    return `${this.rootPath}/questions/${encodeURIComponent(normalizeRequiredString(questionID, 'questionID'))}.json`;
  }

  indexPath() {
    return `${this.rootPath}/questions/index/open.json`;
  }

  agentIndexPath(agentID) {
    return `${this.rootPath}/agents/${encodeURIComponent(normalizeRequiredString(agentID, 'agentID'))}/questions.json`;
  }
}

export const QUESTION_MAX_PER_CALL = MAX_QUESTIONS_PER_CALL;
export const QUESTION_STATUSES = [ ...STATUSES ];
export const QUESTION_TERMINAL_STATUSES = [ ...TERMINAL_STATUSES ];

function compareQuestions(left, right) {
  if (left.askedAt !== right.askedAt)
    return left.askedAt - right.askedAt;

  return left.id.localeCompare(right.id);
}

function compareSummaries(left, right) {
  if (left.askedAt !== right.askedAt)
    return left.askedAt - right.askedAt;

  return left.id.localeCompare(right.id);
}

function normalizeQuestionList(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError('ask-user requires at least one question');

  if (value.length > MAX_QUESTIONS_PER_CALL)
    throw new TypeError(`ask-user accepts at most ${MAX_QUESTIONS_PER_CALL} questions per call`);

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new TypeError(`questions[${index}] must be an object`);

    if (Object.hasOwn(entry, 'options'))
      throw new TypeError(`questions[${index}] must not carry options; answers are free-form`);

    return {
      text: normalizeQuestionText(entry.text),
      priority: normalizePriority(entry.priority),
    };
  });
}

function normalizeQuestionDoc(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  if (typeof value.id !== 'string' || value.id.trim() === '')
    return null;

  if (typeof value.text !== 'string' || value.text.trim() === '')
    return null;

  if (!STATUSES.includes(value.status))
    return null;

  return {
    id: value.id.trim(),
    groupID: normalizeOptionalString(value.groupID) || null,
    index: Number.isInteger(value.index) ? value.index : 1,
    status: value.status,
    mode: MODES.includes(value.mode) ? value.mode : 'wait',
    sessionID: normalizeOptionalString(value.sessionID) || null,
    agentID: normalizeOptionalString(value.agentID) || null,
    interactionID: normalizeOptionalString(value.interactionID) || null,
    frameID: normalizeOptionalString(value.frameID) || null,
    toolCallFrameID: normalizeOptionalString(value.toolCallFrameID) || null,
    toolOutputID: normalizeOptionalString(value.toolOutputID) || null,
    todoIDs: Array.isArray(value.todoIDs) ? value.todoIDs.map((id) => String(id)) : [],
    focusAtAsk: normalizeOptionalString(value.focusAtAsk) || null,
    contextRefs: normalizeContextRefs(value.contextRefs),
    text: value.text.trim(),
    priority: normalizePriority(value.priority),
    answer: typeof value.answer === 'string' ? value.answer : null,
    answeredAt: value.answeredAt || null,
    answeredClock: value.answeredClock || null,
    answeredByUserID: normalizeOptionalString(value.answeredByUserID) || null,
    answerFrameID: normalizeOptionalString(value.answerFrameID) || null,
    dismissalReason: normalizeOptionalString(value.dismissalReason) || null,
    askedAt: value.askedAt || value.createdAt || 0,
    askedClock: value.askedClock || null,
    createdAt: value.createdAt || value.askedAt || 0,
    updatedAt: value.updatedAt || value.createdAt || 0,
    readAt: value.readAt || null,
    deleted: value.deleted === true,
  };
}

function summarizeQuestion(question) {
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
    readAt: question.readAt,
  };
}

// `markUndeliverable` is the one recorded transition that legitimately lands
// on a terminal status: delivery is attempted *after* the answer is persisted,
// so by the time the wake is known to be unsendable the doc is already terminal
// 'answered'. Rejecting that (as assertOpen does) would turn a stored answer
// into a failed request — the exact loss this path exists to prevent.
function assertCanMarkUndeliverable(question) {
  if (question.deleted)
    throw conflict(`Question ${question.id} was deleted; it cannot be marked undeliverable`);

  if (question.status === 'undeliverable')
    throw conflict(`Question ${question.id} is already undeliverable`);

  if (question.status === 'dismissed')
    throw conflict(`Question ${question.id} was dismissed; it cannot be marked undeliverable`);

  if (question.status !== 'open' && question.status !== 'answered')
    throw conflict(`Question ${question.id} is ${question.status}; it cannot be marked undeliverable`);
}

function assertOpen(question, action) {
  if (question.deleted)
    throw conflict(`Question ${question.id} was deleted; it cannot be ${action}`);

  if (TERMINAL_STATUSES.includes(question.status))
    throw conflict(`Question ${question.id} is already ${question.status}; it cannot be ${action}`);
}

function normalizeContextRefs(value) {
  if (!Array.isArray(value))
    return [];

  let refs = [];
  for (let ref of value) {
    if (!ref || typeof ref !== 'object')
      continue;

    let type = normalizeOptionalString(ref.type);
    let id = normalizeOptionalString(ref.id);
    if (!type || !id)
      continue;

    refs.push({
      type,
      id,
      label: normalizeOptionalString(ref.label) || null,
      sessionID: normalizeOptionalString(ref.sessionID) || null,
      frameID: normalizeOptionalString(ref.frameID) || null,
      path: normalizeOptionalString(ref.path) || null,
    });
  }

  return refs;
}

function normalizeQuestionText(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('question text must be a non-empty string');

  return value.trim();
}

function normalizeAnswerText(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('answer must be a non-empty string');

  return value.trim();
}

function normalizePriority(value) {
  let priority = normalizeOptionalString(value).toLowerCase();
  if (!priority)
    return 'normal';

  if (!PRIORITIES.includes(priority))
    throw new TypeError(`priority must be one of ${PRIORITIES.join(', ')}`);

  return priority;
}

function normalizeMode(value) {
  let mode = normalizeOptionalString(value).toLowerCase();
  if (!mode)
    return 'wait';

  if (!MODES.includes(mode))
    throw new TypeError(`mode must be one of ${MODES.join(', ')}`);

  return mode;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}

function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  return `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function notFound(message) {
  let error = new Error(message);
  error.status = 404;
  return error;
}

function conflict(message) {
  let error = new Error(message);
  error.status = 409;
  return error;
}
