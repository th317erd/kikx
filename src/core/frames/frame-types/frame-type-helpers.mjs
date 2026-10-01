'use strict';

// Shared, type-agnostic frame helpers used by the frame-type class hierarchy and
// by the model-context projection. Kept dependency-light so frame classes stay
// small.

import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
} from '../../compaction/agent-compaction-template.mjs';

export function isCompactionFrame(frame) {
  return frame?.type === COMPACTION_FRAME_TYPE || frame?.content?.kind === COMPACTION_FRAME_KIND;
}

export function normalizeAgentDisplayName(frame) {
  for (let value of [
    frame?.authorDisplayName,
    frame?.content?.agentName,
    frame?.authorID,
  ]) {
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  return 'Agent';
}

export function escapeAttribute(value) {
  return String(value).replace(/[&"<>]/g, (char) => {
    if (char === '&')
      return '&amp;';

    if (char === '"')
      return '&quot;';

    if (char === '<')
      return '&lt;';

    return '&gt;';
  });
}
