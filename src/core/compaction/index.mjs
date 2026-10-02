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
  DEFAULT_CHARS_PER_TOKEN,
  MAX_CHUNK_DEPTH,
  TRUNCATED_FRAME_TYPE,
  planCompactionChunks,
  runChunkedCompaction,
  trimOldestToFit,
} from './chunked-compaction.mjs';
export {
  DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS,
  computeCompactionBudget,
  countCompactionMetadataTokens,
  resolveCompactorWindow,
} from './compaction-budget.mjs';
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

