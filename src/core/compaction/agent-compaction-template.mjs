'use strict';

export const COMPACTION_FRAME_TYPE = 'CompactionFrame';
export const COMPACTION_FRAME_KIND = 'compaction_frame';

export function buildDefaultCompactionInstructions() {
  return [
    'This is the context memory of another Kikx agent.',
    'Compress it to save context window space while preserving the information another agent needs to keep working.',
    'Retain important details such as file paths, commands, project/task context, plan details, actor names, agent names, tool run IDs, API/service details, decisions already made, bugs found, evidence locations, and exact next steps.',
    'Preserve any user requirements, constraints, preferences, warnings, and safety boundaries.',
    'Compress words to smaller variants only when the meaning remains unambiguous.',
    'Throw out meaningless conversation, jokes, repeated acknowledgements, transient frustration, and anything that is not truly important.',
    'Produce a PRIORITIZED summary so a smaller model can deliberately drop lower-value material instead of hard-trimming it, and so future compactions can re-compress without losing what matters.',
    'Organize the output into exactly three priority sections, in this order, each introduced by a tag on its own line: [high], [medium], [low].',
    '- [high]: must-keep facts, decisions already made, user requirements/constraints, open tasks, exact next steps, file paths, commands, and anything whose loss would break the work. This section is never dropped.',
    '- [medium]: useful context that helps understanding but could be dropped under pressure, such as rationale, alternatives considered, and background findings.',
    '- [low]: chatter, obsolete or superseded material, and anything already resolved. Safe to drop first.',
    'Within each section prefer compact structured bullets grouped by topic over prose.',
    'Do not invent facts. If something is uncertain, mark it as uncertain (and keep uncertainties at [medium] or higher).',
    'Do your best to minimize overall memory loss.',
  ].join('\n');
}

export function buildAgentCompactionPrompt(input = {}) {
  let {
    instructions = buildDefaultCompactionInstructions(),
    contextText = '',
    sessionID = '',
    frameCount = 0,
    startFrameID = '',
    boundaryFrameID = '',
    contextTokenBudget = null,
  } = input;

  return [
    instructions,
    '',
    'Compaction metadata JSON:',
    JSON.stringify({
      sessionID,
      frameCount,
      startFrameID,
      boundaryFrameID,
      contextTokenBudget,
    }, null, 2),
    '',
    'Return only the compacted context memory. Do not wrap it in commentary about the compaction process.',
    '',
    'Context memory to compact:',
    contextText,
  ].join('\n');
}

