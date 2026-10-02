'use strict';

// Compaction frame construction (P4 extraction; P7 warnings/errors + visibility).
//
// The service owns orchestration; this module owns the shape of the
// `CompactionFrame` and its update. Frames store the verbatim prioritized summary
// string plus the parsed `summaryJSON`, so old readers keep working.
//
// P7 (owner ruling Q2): every compaction frame is ALWAYS VISIBLE (`hidden:false`).
// A failed/trimmed boundary still carries `compactionWindow` metadata (boundary,
// frame IDs, order) so the projection starts exactly after it, and no frame is
// ever deleted. Structured `warnings`/`errors` live on `content` and are mirrored
// on `compaction` for consumers that read the compact field.

import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
} from './agent-compaction-template.mjs';
import { buildCompactionSummaryJSON } from './compaction-summary.mjs';

export function buildCompactionFrame({
  id,
  now,
  session,
  compactorAgent,
  compactionWindow,
  summary,
  summaryJSON,
  status = 'complete',
  hidden = false,
  manual = false,
  requestedByFrameID = null,
  message = '',
  warnings = [],
  errors = [],
}) {
  let frameIDs = compactionWindow.frames.map((frame) => frame.id);
  let boundaryFrame = compactionWindow.frames.at(-1);
  let frameTime = manual ? now : boundaryFrame?.createdAt || boundaryFrame?.timestamp || now;
  let hasSummary = typeof summary === 'string' && summary.trim() !== '';
  let sections = summaryJSON || (hasSummary ? buildCompactionSummaryJSON(summary) : null);
  let normalizedWarnings = normalizeIssues(warnings, now);
  let normalizedErrors = normalizeIssues(errors, now);

  return {
    id,
    type: COMPACTION_FRAME_TYPE,
    sessionID: session.id,
    interactionID: `compaction-${compactionWindow.boundaryFrameID || now}`,
    parentID: compactionWindow.boundaryFrameID || null,
    authorType: 'system',
    authorID: 'internal:compaction',
    authorDisplayName: 'Kikx compaction',
    timestamp: manual ? now : boundaryFrame?.timestamp || now,
    createdAt: frameTime,
    updatedAt: now,
    hidden,
    deleted: false,
    compaction: {
      kind: COMPACTION_FRAME_KIND,
      status,
      manual,
      requestedByFrameID,
      compactorAgentID: compactorAgent?.id || null,
      compactorAgentName: compactorAgent?.name || compactorAgent?.id || null,
      frameCount: frameIDs.length,
      frameIDs,
      startFrameID: compactionWindow.startFrameID,
      boundaryFrameID: compactionWindow.boundaryFrameID,
      boundaryOrder: compactionWindow.boundaryOrder,
      contextTokens: compactionWindow.tokens,
      warnings: normalizedWarnings,
      errors: normalizedErrors,
      createdAt: now,
    },
    content: {
      kind: COMPACTION_FRAME_KIND,
      status,
      text: message || summary || '',
      summary: hasSummary ? summary : '',
      summaryJSON: sections,
      warnings: normalizedWarnings,
      errors: normalizedErrors,
      manual,
      requestedByFrameID,
      compactorAgentID: compactorAgent?.id || null,
      frameCount: frameIDs.length,
      frameIDs,
      startFrameID: compactionWindow.startFrameID,
      boundaryFrameID: compactionWindow.boundaryFrameID,
      boundaryOrder: compactionWindow.boundaryOrder,
    },
  };
}

export function buildCompactionFrameUpdate({
  existing,
  now,
  compactionWindow,
  status,
  summary,
  summaryJSON,
  message,
  compactorAgent,
  warnings,
  errors,
}) {
  let frameIDs = compactionWindow.frames.map((frame) => frame.id);
  // A string summary (including '') is authoritative and clears/replaces memory;
  // `undefined`/`null` keeps the existing summary (back-compat).
  let summaryProvided = typeof summary === 'string';
  let sections = summaryJSON || (summaryProvided ? buildCompactionSummaryJSON(summary) : existing.content?.summaryJSON);
  let warningsValue = warnings == null
    ? (existing.content?.warnings || [])
    : normalizeIssues(warnings, now);
  let errorsValue = errors == null
    ? (existing.content?.errors || [])
    : normalizeIssues(errors, now);

  return {
    ...existing,
    updatedAt: now,
    compaction: {
      ...(existing.compaction || {}),
      status,
      compactorAgentID: compactorAgent?.id || existing.compaction?.compactorAgentID || null,
      compactorAgentName: compactorAgent?.name || compactorAgent?.id || existing.compaction?.compactorAgentName || null,
      frameCount: frameIDs.length,
      frameIDs,
      startFrameID: compactionWindow.startFrameID,
      boundaryFrameID: compactionWindow.boundaryFrameID,
      boundaryOrder: compactionWindow.boundaryOrder,
      contextTokens: compactionWindow.tokens,
      warnings: warningsValue,
      errors: errorsValue,
      updatedAt: now,
    },
    content: {
      ...(existing.content || {}),
      kind: COMPACTION_FRAME_KIND,
      status,
      text: message || summary || existing.content?.text || '',
      summary: summaryProvided ? summary : (existing.content?.summary ?? ''),
      summaryJSON: sections,
      warnings: warningsValue,
      errors: errorsValue,
      compactorAgentID: compactorAgent?.id || existing.content?.compactorAgentID || null,
      frameCount: frameIDs.length,
      startFrameID: compactionWindow.startFrameID,
      boundaryFrameID: compactionWindow.boundaryFrameID,
      boundaryOrder: compactionWindow.boundaryOrder,
    },
  };
}

// Normalize warnings/errors to the structured `{ message, at, kind }` contract.
// Accepts plain strings (turned into `{ message, at: now, kind }`) and objects,
// dropping entries with no usable message so an empty list stays genuinely empty.
export function normalizeIssueEntries(entries, at) {
  let list = Array.isArray(entries) ? entries : (entries == null ? [] : [ entries ]);
  let normalized = [];

  for (let entry of list) {
    if (typeof entry === 'string') {
      let message = entry.trim();
      if (message !== '')
        normalized.push({ message, at, kind: 'compaction' });
      continue;
    }

    if (!entry || typeof entry !== 'object')
      continue;

    let message = typeof entry.message === 'string' ? entry.message.trim() : '';
    if (message === '')
      continue;

    normalized.push({
      message,
      at: entry.at ?? at,
      kind: typeof entry.kind === 'string' && entry.kind.trim() !== '' ? entry.kind : 'compaction',
    });
  }

  return normalized;
}

function normalizeIssues(entries, at) {
  return normalizeIssueEntries(entries, at);
}
