'use strict';

// Compaction frame construction (P4 extraction).
//
// The service owns orchestration; this module owns the shape of the hidden
// `CompactionFrame` and its update. Frames store the verbatim prioritized summary
// string plus the parsed `summaryJSON`, so old readers keep working.

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
  hidden = true,
  manual = false,
  requestedByFrameID = null,
  message = '',
}) {
  let frameIDs = compactionWindow.frames.map((frame) => frame.id);
  let boundaryFrame = compactionWindow.frames.at(-1);
  let frameTime = manual ? now : boundaryFrame?.createdAt || boundaryFrame?.timestamp || now;
  let sections = summaryJSON || buildCompactionSummaryJSON(summary);

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
      createdAt: now,
    },
    content: {
      kind: COMPACTION_FRAME_KIND,
      status,
      text: message || summary,
      summary,
      summaryJSON: sections,
      manual,
      requestedByFrameID,
      compactorAgentID: compactorAgent?.id || null,
      frameCount: frameIDs.length,
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
}) {
  let frameIDs = compactionWindow.frames.map((frame) => frame.id);
  let sections = summaryJSON || (typeof summary === 'string' ? buildCompactionSummaryJSON(summary) : existing.content?.summaryJSON);

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
      updatedAt: now,
    },
    content: {
      ...(existing.content || {}),
      kind: COMPACTION_FRAME_KIND,
      status,
      text: message || summary || existing.content?.text || '',
      summary: summary ?? existing.content?.summary ?? '',
      summaryJSON: sections,
      compactorAgentID: compactorAgent?.id || existing.content?.compactorAgentID || null,
      frameCount: frameIDs.length,
      startFrameID: compactionWindow.startFrameID,
      boundaryFrameID: compactionWindow.boundaryFrameID,
      boundaryOrder: compactionWindow.boundaryOrder,
    },
  };
}
