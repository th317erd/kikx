'use strict';

export const DEFAULT_MERGE_SUMMARY_MIN_TOKENS = 512;

// Least priority first: the target session (its material is already in the
// destination), then the largest source sessions because compacting them frees
// the most room for complete uncompacted sessions.
export function sessionMergeOrder(sessions = [], targetSessionID = '') {
  return (Array.isArray(sessions) ? sessions : [])
    .slice()
    .sort((left, right) => {
      if (left.sessionID === targetSessionID)
        return -1;
      if (right.sessionID === targetSessionID)
        return 1;
      return (right.tokens || 0) - (left.tokens || 0)
        || String(left.sessionID).localeCompare(String(right.sessionID));
    });
}

// Estimate the minimum prefix that must be compacted so the remaining full
// sessions plus one summary per compacted session fit the compactor budget.
// This is deliberately a planning estimate; the caller re-checks actual summary
// sizes and can compact another parallel batch if the model returns long summaries.
export function planSessionCompactions({
  sessions = [],
  targetSessionID = '',
  budgetTokens = 1,
  summaryTokensFor = defaultSummaryTokensFor,
} = {}) {
  let list = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session?.sessionID)
    .map((session) => ({ ...session, tokens: Math.max(0, Number(session.tokens) || 0) }));
  let budget = Math.max(1, Number(budgetTokens) || 1);
  let total = list.reduce((sum, session) => sum + session.tokens, 0);
  let order = sessionMergeOrder(list, targetSessionID);
  if (total <= budget)
    return { selectedSessionIDs: [], order, projectedTokens: total, fitsWithoutCompaction: true, totalTokens: total };

  let selected = [];
  let selectedSet = new Set();
  let projected = total;
  for (let session of order) {
    if (projected <= budget)
      break;
    let summaryTokens = Math.max(1, Math.floor(summaryTokensFor(session, budget) || 0));
    projected = projected - session.tokens + summaryTokens;
    selected.push(session.sessionID);
    selectedSet.add(session.sessionID);
  }

  return {
    selectedSessionIDs: selected,
    selectedSessionIDSet: selectedSet,
    order,
    projectedTokens: projected,
    fitsWithoutCompaction: false,
    totalTokens: total,
  };
}

export function defaultSummaryTokensFor(session, budgetTokens) {
  let tokens = Math.max(0, Number(session?.tokens) || 0);
  let budget = Math.max(1, Number(budgetTokens) || 1);
  return Math.min(tokens, Math.max(DEFAULT_MERGE_SUMMARY_MIN_TOKENS, Math.floor(budget * 0.04)));
}
