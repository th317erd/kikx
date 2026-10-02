'use strict';

export {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
  buildAgentCompactionPrompt,
  buildDefaultCompactionInstructions,
} from './agent-compaction-template.mjs';
export {
  FrameContextBuilder,
  estimateTokens,
  isCompactionFrame,
  serializeFrameForContext,
  serializeFramesForCompaction,
} from './frame-context-builder.mjs';
export {
  DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
  resolveEffectiveContextWindow,
  resolveSessionWindows,
  smallestParticipantWindow,
} from './effective-windows.mjs';
export {
  COMPACTOR_REASON,
  selectCompactor,
} from './select-compactor.mjs';
export {
  COMPACTION_LEVELS,
  COMPACTION_SECTION_HEADER,
  MEDIUM_CONTEXT_WINDOW_TOKENS,
  SMALL_CONTEXT_WINDOW_TOKENS,
  buildCompactionSummaryJSON,
  hasCompactionSections,
  parseCompactionSections,
  renderCompactionSections,
  selectCompactionLevels,
} from './compaction-summary.mjs';
export { CompactionService } from './compaction-service.mjs';

