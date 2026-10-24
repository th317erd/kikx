'use strict';

import { compareSummaries } from './question-doc.mjs';
import { resolveVisibleSessionIDs, visibleQuestionDigest } from './question-dedupe.mjs';

const STATUS_VALUES = new Set([ 'open', 'answered', 'dismissed', 'undeliverable', 'all' ]);
const SCOPES = new Set([ 'tree', 'session', 'all' ]);

export async function queryQuestions(store, filters = {}) {
  let scope = normalizeScope(filters.scope);
  let status = normalizeStatus(filters.status);
  let rootSessionID = normalizeString(filters.rootSessionID || filters.root_session_id || filters.sessionID || filters.session_id);
  if (scope !== 'all' && rootSessionID === '')
    throw new TypeError('question-list requires session_id unless scope is all');

  let sessions = await store.listSessionTree();
  let sessionIDs = scope === 'all'
    ? uniqueSessions(sessions)
    : resolveVisibleSessionIDs(rootSessionID, sessions);
  if (scope === 'session')
    sessionIDs = [ rootSessionID ];

  let query = normalizeString(filters.query || filters.q).toLowerCase();
  let agentID = normalizeString(filters.agentID || filters.agent_id);
  let groupID = normalizeString(filters.groupID || filters.group_id);
  let priority = normalizeString(filters.priority).toLowerCase();
  let limit = normalizeLimit(filters.limit);
  let offset = normalizeOffset(filters.offset);
  let sessionSet = new Set(sessionIDs);
  let openDigest = '';

  let questions;
  if (status === 'open') {
    let open = await store.listOpen({
      ...(scope === 'all'
        ? {}
        : scope === 'session'
          ? { sessionID: rootSessionID }
          : { rootSessionID, includeDescendants: true }),
      agentID,
      groupID,
      priority,
      query,
    });
    let summaries = open.summaries.filter((summary) => sessionSet.has(summary.sessionID));
    let hasFilters = Boolean(query || agentID || groupID || priority);
    if (scope === 'all' || !hasFilters) {
      openDigest = visibleQuestionDigest(summaries);
    } else {
      let full = await store.listOpen({
        ...(scope === 'session'
          ? { sessionID: rootSessionID }
          : { rootSessionID, includeDescendants: true }),
      });
      openDigest = visibleQuestionDigest(full.summaries.filter((summary) => sessionSet.has(summary.sessionID)));
    }
    questions = await store.readQuestionsByID(summaries.map((summary) => summary.id));
  } else {
    questions = await store.listQuestionsInSessions(sessionIDs);
  }

  questions = questions.filter((question) => questionMatches(question, {
    status,
    query,
    agentID,
    groupID,
    priority,
    sessionSet,
  }));
  questions.sort(compareSummaries);

  let total = questions.length;
  let page = questions.slice(offset, offset + limit);
  return {
    scope,
    rootSessionID: rootSessionID || null,
    sessionIDs,
    status,
    query: query || null,
    total,
    offset,
    limit,
    hasMore: offset + page.length < total,
    openDigest,
    questions: page.map(publicQuestion),
  };
}

function questionMatches(question, filters) {
  if (!filters.sessionSet.has(question.sessionID))
    return false;
  if (filters.status !== 'all' && question.status !== filters.status)
    return false;
  if (filters.agentID && question.agentID !== filters.agentID)
    return false;
  if (filters.groupID && question.groupID !== filters.groupID)
    return false;
  if (filters.priority && question.priority !== filters.priority)
    return false;
  if (!filters.query)
    return true;

  let haystack = [
    question.text,
    question.answer,
    question.dismissalReason,
    ...(Array.isArray(question.contextRefs)
      ? question.contextRefs.flatMap((ref) => [ ref.type, ref.id, ref.label ])
      : []),
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes(filters.query);
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

function uniqueSessions(sessions) {
  let ids = [];
  let seen = new Set();
  for (let session of Array.isArray(sessions) ? sessions : []) {
    let id = normalizeString(session?.id);
    if (!id || seen.has(id))
      continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeScope(value) {
  let scope = normalizeString(value).toLowerCase() || 'tree';
  return SCOPES.has(scope) ? scope : 'tree';
}

function normalizeStatus(value) {
  let status = normalizeString(value).toLowerCase() || 'open';
  return STATUS_VALUES.has(status) ? status : 'open';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLimit(value) {
  let number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, 200) : 50;
}

function normalizeOffset(value) {
  let number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}
