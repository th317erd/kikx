'use strict';

import { randomUUID } from 'node:crypto';

import {
  AGENT_ANSWER_SOURCE,
  USER_ANSWER_SOURCE,
  normalizeTimeoutMs,
  normalizeContextRefs,
  normalizeQuestionText,
  normalizeAnswerText,
  normalizePriority,
  normalizeMode,
  normalizeOptionalString,
  normalizeWakeSuppressed,
  QUESTION_MODES,
} from './question-fields.mjs';
import {
  QUESTIONS_INDEX_LOCK_KEY,
  assertCanMarkUndeliverable,
  assertOpen,
  cloneJSON,
  compareQuestions,
  compareSummaries,
  normalizeQuestionDoc,
  normalizeQuestionList,
  normalizeRequiredString,
  normalizeRoot,
  notFound,
  summarizeQuestion,
} from './question-doc.mjs';

import {
  resolveVisibleSessionIDs,
  selectVisiblePendingQuestions,
  visibleQuestionDigest,
} from './question-dedupe.mjs';

const DEFAULT_ROOT_PATH = '/kikx';


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
    // Batch-level refs are a FALLBACK for questions that carry none of their
    // own. The schema declares `contextRefs` per question, so a per-question
    // value always wins; this stays for callers (and older stored docs) that
    // framed the whole group at once.
    let batchContextRefs = normalizeContextRefs(input.contextRefs || input.context_refs);
    let note = normalizeOptionalString(input.note);
    let groupID = this.idGenerator();
    let now = this.clock();
    let created = [];

    for (let [ offset, entry ] of questions.entries()) {
      // An agent may name an acceptable default and a deadline. Persisting the
      // absolute deadline (not just the duration) is what makes the default
      // survive a restart: the scheduler compares it against the clock.
      // `normalizeQuestionList` has already validated and coerced these.
      let defaultAnswer = entry.defaultAnswer;
      let timeoutMs = entry.timeoutMs;

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
        contextRefs: entry.contextRefs.length > 0 ? entry.contextRefs : batchContextRefs,
        text: entry.text,
        priority: entry.priority,
        answer: null,
        // A question starts un-suppressed; only a user dismissal sets this.
        wakeSuppressed: false,
        // Free-form by D-4; a default is the agent's own fallback, never a
        // preset option presented to the user.
        defaultAnswer: defaultAnswer || null,
        defaultTimeoutMs: timeoutMs,
        defaultDueAt: defaultAnswer && timeoutMs != null ? now + offset + timeoutMs : null,
        answerSource: null,
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
      let answerSource = normalizeOptionalString(input.answerSource || input.answer_source) === AGENT_ANSWER_SOURCE
        ? AGENT_ANSWER_SOURCE
        : USER_ANSWER_SOURCE;
      let updated = {
        ...question,
        status: 'answered',
        answer,
        // Provenance, written at last. Without it a stored human answer and an
        // unanswered question look identical, so nothing downstream can tell
        // "a person replied" from "nobody ever did", which is the whole basis
        // of the revision path (only a 'default' answer may be overridden).
        answerSource,
        answeredAt: now,
        answeredByUserID: answerSource === USER_ANSWER_SOURCE
          ? (normalizeOptionalString(input.userID || input.user_id) || null)
          : null,
        answeredByAgentID: answerSource === AGENT_ANSWER_SOURCE
          ? (normalizeOptionalString(input.answeredByAgentID || input.answered_by_agent_id) || null)
          : null,
        answerFrameID: normalizeOptionalString(input.answerFrameID || input.answer_frame_id) || null,
        // Sticky once set. The only write that can follow an answer is
        // `reviseAnswer`, and that one happens exclusively when a DEFAULT
        // answered and a person has since contradicted it. A dismissal can
        // never be revised: `isRevisableDefaultAnswer` requires
        // `answerSource === 'default'`. So a re-read of the doc still always
        // agrees with the fact that no wake was ever sent for the dismissal.
        wakeSuppressed: normalizeWakeSuppressed(input.wakeSuppressed) || question.wakeSuppressed === true,
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

      // The open index carries `readAt` in every summary and is the ONLY source
      // the Inbox reads (`listOpen`). Without this rewrite the doc said "read"
      // while the index still said "unread", so the badge counted the question
      // again on the next fetch and never cleared.
      await this.writeIndexes([ id ], [ question.agentID ]);

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
    let rootSessionID = normalizeOptionalString(filters.rootSessionID || filters.root_session_id);
    let includeDescendants = filters.includeDescendants === true || filters.include_descendants === true;
    let agentID = normalizeOptionalString(filters.agentID || filters.agent_id);
    let groupID = normalizeOptionalString(filters.groupID || filters.group_id);
    let query = normalizeOptionalString(filters.query || filters.q).toLowerCase();
    let priority = normalizeOptionalString(filters.priority).toLowerCase();

    let root = rootSessionID || (includeDescendants ? sessionID : '');
    let visibleSessionIDs = root
      ? new Set(resolveVisibleSessionIDs(root, await this.listSessionTree()))
      : null;

    if (visibleSessionIDs)
      summaries = summaries.filter((entry) => visibleSessionIDs.has(entry.sessionID));
    else if (sessionID)
      summaries = summaries.filter((entry) => entry.sessionID === sessionID);

    if (agentID)
      summaries = summaries.filter((entry) => entry.agentID === agentID);

    if (groupID)
      summaries = summaries.filter((entry) => entry.groupID === groupID);

    if (priority)
      summaries = summaries.filter((entry) => entry.priority === priority);

    if (query)
      summaries = summaries.filter((entry) => String(entry.text || '').toLowerCase().includes(query));

    return {
      ids: summaries.map((entry) => entry.id),
      summaries: summaries.map(cloneJSON),
      updatedAt: index.updatedAt || null,
    };
  }

  /**
   * Visible pending questions for a session tree: the root session plus every
   * descendant, never siblings or unrelated sessions.
   *
   * Reads the open index only (no per-question scans), then fetches the
   * matching question docs so the caller gets `answer`, `answerSource`, and
   * `dismissalReason` too. Those fields are what let an agent tell a real user
   * decision from its own `defaultAnswer` assumption — without them a bot
   * cannot know whether a "answered" question was actually decided.
   *
   * `openDigest` is a pure sha256 of the pending set, which is what `ask-user`
   * demands before it will write.
   */
  async listVisibleQuestions({ sessionID, rootSessionID, status = 'open' } = {}) {
    let root = normalizeOptionalString(rootSessionID) || normalizeOptionalString(sessionID);
    if (!root)
      throw new TypeError('listVisibleQuestions requires sessionID');

    let visibleSessionIDs = resolveVisibleSessionIDs(root, await this.listSessionTree());
    let index = await this.readOpenIndex();
    let pending = selectVisiblePendingQuestions(index.summaries, visibleSessionIDs);
    let normalizedStatus = normalizeOptionalString(status) || 'open';

    // The open index carries open questions only — that is what keeps the Inbox
    // fast. So the pending set always comes from it, which is also why the
    // digest can only ever describe the pending set. Anything broader has to
    // read the per-question docs, and only when the caller explicitly asks:
    // answering "did the user already handle the rest of my batch?" requires
    // seeing terminal questions too.
    let questions = normalizedStatus === 'open'
      ? await this.readQuestionsByID(pending.map((summary) => summary.id))
      : await this.listQuestionsInSessions(visibleSessionIDs);

    if (normalizedStatus !== 'all')
      questions = questions.filter((question) => question.status === normalizedStatus);

    questions.sort(compareSummaries);

    return {
      rootSessionID: root,
      sessionIDs: visibleSessionIDs,
      openDigest: visibleQuestionDigest(pending),
      questions,
      total: questions.length,
    };
  }

  async readQuestionsByID(questionIDs = []) {
    let questions = [];

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
        questions.push(question);
    }

    return questions;
  }

  /**
   * Every question in the given sessions, whatever its status. Opt-in only —
   * this reads the per-question docs, which is exactly the scan the open index
   * exists to avoid on the Inbox path.
   */
  async listQuestionsInSessions(sessionIDs = []) {
    let allowed = new Set(Array.isArray(sessionIDs) ? sessionIDs : []);
    let { items } = await this.aeordb.list(`${this.rootPath}/questions`, { glob: '*.json' });
    let questions = [];

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
      if (!question)
        continue;

      if (!allowed.has(question.sessionID))
        continue;

      questions.push(question);
    }

    return questions;
  }

  /**
   * Sessions, for the parent/child walk. Best-effort: a store without a session
   * tree degrades to "just this session", which is strictly narrower, never wider.
   */
  async listSessionTree() {
    let lister = this.frameStore || this.aeordb?.frameStore || null;
    if (typeof lister?.listSessions !== 'function')
      return [];

    try {
      return await lister.listSessions({ limit: 5000 });
    } catch (_error) {
      return [];
    }
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
    return await this.withLock(
      QUESTIONS_INDEX_LOCK_KEY,
      () => this.writeIndexesUnlocked(questionIDs, touchedAgentIDs, extraAgentIDs),
    );
  }

  /**
   * Body of `writeIndexes`. Callers must NOT invoke this directly: it performs
   * the read-modify-write on the shared index with no mutual exclusion.
   */
  async writeIndexesUnlocked(questionIDs, touchedAgentIDs = [], extraAgentIDs = []) {
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

// AeorDB offers no conditional write, so the open index is a read-modify-write
// document shared by every question in the store. Mutations therefore serialise
// on the index itself; the per-question mutexes cannot do this job because two
// answers to two *different* questions hold two *different* keys.