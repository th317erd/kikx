'use strict';

export {
  BRIEF_FORBIDDEN_PHRASES,
  buildMessageBrief,
  buildStartBrief,
  findForbiddenBriefPhrase,
} from './agent-brief-template.mjs';

export const AGENTIC_SCRIPT_NAME = 'agentic script';

// Review inputs are capped so a completion self-review request cannot explode
// when the draft itself is enormous. Large draft frames are truncated with an
// explicit marker; the review path additionally skips the pass entirely when
// the capped prompt still does not fit the model budget.
export const DEFAULT_MAX_REVIEW_FRAME_CHARS = 8000;
export const DEFAULT_MAX_REVIEW_DRAFT_CHARS = 24000;

export function buildCompletionReviewScriptPrompt(input = {}) {
  let {
    frameMessage = '',
    finalFrameContent = {},
    toolDefinitions = [],
    maxFrameChars = DEFAULT_MAX_REVIEW_FRAME_CHARS,
    maxDraftChars = DEFAULT_MAX_REVIEW_DRAFT_CHARS,
  } = input;

  let cappedFrameMessage = capText(frameMessage, maxFrameChars);
  let cappedDraft = capText(JSON.stringify(finalFrameContent || {}, null, 2), maxDraftChars);

  return [
    'Completion self-review.',
    '',
    'You are about to finish this Kikx agentic turn. Before the visible answer is sent, audit your draft.',
    'This audit is private control logic. Do not output the self-review itself as the visible response.',
    'The visible response must be the actual answer, report, or progress message for the original user/request frame.',
    '',
    'Ask yourself:',
    '1. Have you completed all the tasks the user requested of you?',
    '2. What evidence proves completion?',
    '3. What did you miss?',
    '4. What did you forget?',
    '5. What could you have done better?',
    '',
    'If every requested task is complete, call agent-finalize with the final visible response only. You may reuse or improve the draft, but do not include this checklist or meta-review.',
    'If you are not done, do not finalize as if you are done. Explain to the user what you are going to do next, then get started by using agent-progress and the needed task tools, or agent-respond-and-continue if the continuation must happen later.',
    'If the draft asks the user whether you should perform an obvious next safe/read-only step, treat the draft as incomplete. Do the next step yourself instead of asking for permission.',
    'Do not repeat completed tool calls unless the self-review identifies a concrete missing check or missing task.',
    '',
    'Original user/request frame text:',
    cappedFrameMessage,
    '',
    'Draft visible response JSON:',
    cappedDraft,
    '',
    'Available tools:',
    formatAgenticScriptToolHelp(toolDefinitions),
    '',
    'Now complete the self-review and take the correct next action.',
  ].join('\n');
}

// Truncate oversized review inputs with an explicit marker so the prompt cannot
// grow without bound. Non-positive limits disable the cap.
export function capText(value, maxChars) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars)
    return text;

  let omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[truncated: ${omitted} characters omitted]`;
}

export function formatAgenticScriptToolHelp(toolDefinitions) {
  return (Array.isArray(toolDefinitions) ? toolDefinitions : [])
    .map((toolDefinition) => `- ${toolDefinition.name}: ${toolDefinition.help || toolDefinition.description || ''}`)
    .join('\n');
}
