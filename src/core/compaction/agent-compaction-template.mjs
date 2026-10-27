'use strict';

export const COMPACTION_FRAME_TYPE = 'CompactionFrame';
export const COMPACTION_FRAME_KIND = 'compaction_frame';

export function buildDefaultCompactionInstructions() {
  return [
    'This is the context memory of another Kikx agent.',
    'Compress it to save context window space while preserving the information another agent needs to keep working.',
    'Retain important details such as file paths, commands, project/task context, plan details, tool run IDs, API/service details, decisions already made, bugs found, evidence locations, and exact next steps.',
    'Preserve any user requirements, constraints, preferences, warnings, and safety boundaries.',
    'Write this as a handoff for the next agent, not an audit trail. Lead [high] with: (1) the CURRENT objective or newest user request, (2) only the verified state needed to act, and (3) the open work and exact next step.',
    'Do not lead with repository, git, gate, todo, or process history. Include a fact only if losing it would change the next action. Resolved blockers, superseded commits/HEADs, old test counts, completed todos, and expired paths belong in [low] or should be omitted entirely — never present them as active work.',
    'If the newest user request conflicts with older remembered state, the newest request wins and the older state is superseded. Mark anything unresolved as unresolved; do not carry stale status forward as fact.',
    'Do not restate standard prompts, standing process rules, character, participants, the todo list, cwd, or the tool list; those are supplied fresh every turn. Keep [high] tight, move rationale/background to [medium], and reserve [low] for genuinely droppable material.',
    'The receiving agent is already given its character, the session participants (names, IDs, and coordinator flag), the todo list, the working directory, and the available tool list, so do not restate those.',
    'Compress words to smaller variants only when the meaning remains unambiguous.',
    'Throw out meaningless conversation, jokes, repeated acknowledgements, transient frustration, base64 blobs, and other large low-value blobs of data that can be referenced elsewhere (for example, by a tool-output ID or locator). Also throw out anything that is not truly important.',
    'Produce a PRIORITIZED summary so a smaller model can deliberately drop lower-value material instead of hard-trimming it, and so future compactions can re-compress without losing what matters.',
    'Organize the output into exactly three priority sections, in this order, each introduced by a tag on its own line: [high], [medium], [low].',
    '- [high]: must-keep facts, decisions already made, user requirements/constraints, open tasks, exact next steps, file paths, commands, and anything whose loss would break the work. This section is never dropped.',
    '- [medium]: useful context that helps understanding but could be dropped under pressure, such as rationale, alternatives considered, and background findings.',
    '- [low]: chatter, obsolete or superseded material, and anything already resolved. Safe to drop first.',
    'Use this [high] shape, in this order (headings are encouraged):',
    'Current objective: one or two sentences stating what the next agent must accomplish now.',
    'Governing user requests: a compact list, newest first; quote the latest request when short. Preserve the latest accepted correction and the authorized scope. Include only requests that still constrain the work.',
    'Current verified state: only facts needed to act. Include decisions and why, errors and fixes, evidence already observed, what remains unverified, and exact next steps or commands. Distinguish requested outcomes from hypothetical improvements.',
    'Open work / next move: what is unfinished, what is blocked, and the single most concrete next action.',
    'Relevant files: exact paths, symbols, tool-output IDs, URLs, and commands that matter. Refer to todo items by title, not opaque IDs; IDs belong only in tool arguments.',
    'Within each section prefer compact structured bullets grouped by topic over prose. Do not use prose paragraphs or a nested summary.',
    'Do not invent facts. If something is uncertain, mark it as uncertain (and keep uncertainties at [medium] or higher).',
    'Do your best to minimize overall memory loss.',
    'The material may include a previous summary or compaction frames (shown as "Compacted context memory"). Treat them as the prior summary and merge them into THIS summary. Carry forward the current objective, constraints, decisions, unresolved blockers, and parallel workstreams even when the newer conversation does not repeat them. The newer conversation wins conflicts; move completed work to completed/resolved and update the objective/next move. Do not quote, list, or reproduce the prior summary.',
    'Produce ONE consolidated, stand-alone handoff. Never emit more than one compaction, never refer to prior compactions by id or title, and never mention the summary or compaction process. The next agent should resume the current work naturally, not restart it or treat the summary as a new assignment.',
    // P6 / R6 realign hook — placeholder. The mission/"vision" system does not
    // exist yet, so keep this blurb generic; wire it to the real source when it
    // lands. Do not invent a mission source here.
    'Towards the end of the summary, include a short blurb of instructions helping bots realign and reorient themselves with the vision and mission at hand before they proceed.',
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

