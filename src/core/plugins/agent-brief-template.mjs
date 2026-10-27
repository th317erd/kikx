'use strict';

// Two-tier brief builders (P2). Pure functions: each returns `{ text }` and has
// no side effects. Brief A is produced ONCE per (re)start and is embedded inside
// the final Brief B user turn; Brief B is produced every turn and every tool
// round. Providers stay ignorant of the split — model-context assembly decides
// the emitted message shape.

import {
  AGIS_PRECEPTS_LINES,
  COORDINATOR_DELEGATION_NUDGE_LINES,
  COORDINATOR_PREAMBLE_LINES,
  MULTIPARTY_CHARACTER_NOTE_LINES,
  PRE_START_READ_LINES,
  STANDARD_BEHAVIOR_LINES,
  STANDARD_TOOL_NOTES_LINES,
  USER_MESSAGE_ACK_LINE,
  packageVersion,
} from './agent-precepts.mjs';
import {
  collectPartyActors,
  hasCoordinatorParties,
  hasMultiparty,
  resolveParticipantName,
} from './agent-participants.mjs';
import { sessionGeneration } from './agent-normalizers.mjs';
import { resolveCompressedCharacter } from '../agents/character-limits.mjs';

// P8.3: language that nudges a model to hurry or act out of fear of missing
// out. The two-tier briefs must never reintroduce it; the brief spec greps both
// assembled briefs against this explicit denylist. Matched case-insensitively
// with word boundaries.
export const BRIEF_FORBIDDEN_PHRASES = [
  'prefer completing the task in one turn',
  'complete the task in one turn',
  'fear of missing out',
];

export function findForbiddenBriefPhrase(text) {
  let haystack = String(text ?? '').toLowerCase();
  for (let phrase of BRIEF_FORBIDDEN_PHRASES) {
    let pattern = new RegExp(`\\b${escapeRegExp(phrase)}\\b`);
    if (pattern.test(haystack))
      return phrase;
  }

  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Static, compact tool map from the rev-3 Brief A. Grouped by purpose; the
// per-tool `help` text lives in the tool definitions and is referenced here.
const BRIEF_TOOL_LINES_COMMON = [
  '  turn:      end-turn (goals summary + steps taken, optional details, or silent), continue-turn',
  '             (keep working, wake later), progress',
  '  route:     route (coordinator only)',
  '  control:   stop, set-character, exec-suspend, exec-resume, exec-kill;',
  '             session-control (coordinator; current or descendant session),',
  '             session-merge/session-merge-status (coordinator-only session consolidation)',
  '  help:      help (lists all tools; each tool has its own help)',
  '  work:      read-file, write-file, exec, exec-script, exec-list, exec-status, exec-read,',
  '             exec-grep, web-fetch, web-search, ocr, feedback-report',
  '  tags:      tag-create, tag-list, tag-get/tag-read, tag-update, tag-delete (any target_type/target_id)',
  '  ask:       question-list (filters: scope tree/session/all, status, query,',
  '             session/agent/group/priority), question-get, question-create',
  '             (needs the openDigest from question-list), question-answer and',
  '             question-dismiss (coordinator-only), ask-user (legacy create).',
  '             wait = end your turn; continue = keep working and steer.',
  '  session:   session-create, session-invite-agents (explicit session_id),',
  '             session-message (explicit session_id), session-frames, session-search, agent-list',
  '  state:     todo-*, cwd-*',
];

function buildBriefToolLines(_context = {}) {
  return [ 'Tools:', ...BRIEF_TOOL_LINES_COMMON ];
}

// The turn-ending phrase (dual verb). It carries the definition-of-done rule:
// stop when the request is satisfied OR when you are only waiting; continue only
// for actionable work you can do right now. Waiting (on a process, the user, or
// another agent) is never a reason to keep turning — each will wake you. This is
// the whole per-turn contract for ending a turn.
export const TURN_ENDING_LINES = [
  USER_MESSAGE_ACK_LINE,
  'End every turn one of two ways:',
  '- end-turn — with a REQUIRED short summary of goals completed (one or two sentences) followed by a short bulleted list of steps taken, plus optional details — when the requested outcome has sufficient evidence, or when you are pausing/waiting after work. Do not extend the task for hypothetical improvements. Put evidence, proof, risks, and remaining/next in details. Omit both only when you did no visible work and have nothing new to report.',
  '- continue-turn — with a visible progress update, a mood score from -3 to +3 plus a one-word mood label, and the next concrete step — only when you have actionable work you can do right now.',
  'Waiting is not working: never poll or loop to await a process, the user, or another agent — a completion or a reply will wake you. If clearly-required work remains but you do not yet know the step, keep planning.',
  'A passing test, commit, push, restart, or accepted send proves only its own milestone, not downstream delivery; name what remains unverified.',
  'Stay aligned with the task the user gave you — vision → mission → current todos. If what you\'re doing isn\'t the user-assigned work, stop.',
];

function buildMessageBriefAnswerLine(_context = {}) {
  return TURN_ENDING_LINES.join('\n');
}

// AGIS precept lines are always included; the tool map and turn-ending phrase
// carry the turn contract.
function buildBriefPreceptLines(_context = {}) {
  return AGIS_PRECEPTS_LINES;
}

// Brief A ("start brief") — sent ONCE per (re)start: session start, new agent,
// after compaction, coordinator change.
export function buildStartBrief(context = {}) {
  // Prefer the stored compressed character (P6/D2); fall back through the
  // historical aliases and finally the full character so Brief A always carries
  // the agent's persona, including agents created before the compressed field.
  let character = normalizeBriefString(
    resolveCompressedCharacter(context.agent)
      || context.agent?.character
      || context.character,
  ) || 'No custom character has been set. Act as a careful, technically rigorous Kikx agent.';

  let canStaySilent = hasCoordinatorParties(context);
  let intro = [
    'Act as a careful, technically rigorous agent. Use any tools as-needed. Never',
    'claim work your own tool frames do not show; always leave a truth/proof artifact.',
  ];

  let lines = [
    `Kikx Advanced Agent Harness - v${packageVersion()}`,
    '',
    ...PRE_START_READ_LINES,
    '',
    ...intro,
    '',
    `Character: ${character}`,
  ];

  if (hasMultiparty(context) && canStaySilent) {
    lines.push('');
    lines.push(...MULTIPARTY_CHARACTER_NOTE_LINES);
  }

  lines.push('');
  lines.push(...buildBriefPreceptLines(context));
  lines.push('');
  lines.push(...buildBriefToolLines(context));
  lines.push('');
  lines.push(...STANDARD_TOOL_NOTES_LINES);
  lines.push('');
  lines.push(...STANDARD_BEHAVIOR_LINES);
  lines.push(...buildDelegationBriefLines(resolveSessionGeneration(context)));

  if (context.isCoordinator === true && hasCoordinatorParties(context)) {
    lines.push('');
    lines.push(...COORDINATOR_PREAMBLE_LINES);
  }

  return { text: lines.join('\n') };
}

function buildCompactionWarningLines(context = {}) {
  let memory = context.contextMemory || {};
  let pending = memory.compactionPending === true || context.compactionPending === true;
  let trimmed = memory.contextTrimmed === true || context.contextTrimmed === true;
  if (!pending && !trimmed)
    return [];

  let headline = pending
    ? 'Context compaction is underway and older memories are temporarily suspended.'
    : 'Context was trimmed to fit the model window and older memories are temporarily suspended.';

  return [
    '',
    `!!!WARNING!!! ${headline} Data is KNOWN TO BE MISSING FROM YOUR MEMORY.`,
    'This is usually not critical. Do not poll or schedule a timer to await compaction; the runtime will resume you when it completes.',
  ];
}

// Brief B ("message brief") — sent EVERY turn and every tool round.
export function buildMessageBrief(context = {}) {
  let sender = resolveBriefSender(context);
  let stamp = resolveBriefTimestamp(context);
  let message = normalizeBriefString(context.messageText) || normalizeBriefString(context.frame?.content?.text);
  let startBriefText = normalizeBriefString(context.startBriefText);
  let todo = resolveBriefTodo(context);
  let questions = resolveBriefQuestions(context);
  let cwd = normalizeBriefString(context.cwdState?.cwd || context.cwd) || 'none';
  let coordinator = context.isCoordinator === true;
  let parties = formatBriefPartyLines(context);
  let autonomous = buildAutonomousRunLine(context);

  return {
    text: [
      // The raw message must stay first. The next turn replays it as a history
      // turn, so everything before it would break the provider's cached prefix.
      message,
      '',
      ...(startBriefText ? [ startBriefText, '' ] : []),
      `Turn context — from ${sender} ${stamp}:`,
      `todo:    ${todo}`,
      ...(questions ? [ `open:    ${questions}` ] : []),
      `cwd:     ${cwd}`,
      `coord:   ${coordinator}`,
      `parties: ${parties}`,
      ...(autonomous ? [ '', autonomous ] : []),
      ...(context.isCoordinator === true ? [ '', ...COORDINATOR_DELEGATION_NUDGE_LINES ] : []),
      ...(context.suspensionWarning ? [ '', context.suspensionWarning ] : []),
      ...buildCompactionWarningLines(context),
      '',
      buildMessageBriefAnswerLine(context),
    ].join('\n'),
  };
}

// Stateful clue for autonomous (self-triggered) turns. `a07faa16` looped because
// the model could not see that it was repeating: nothing told it a step was
// self-scheduled. This line gives it that fact without forbidding work. An
// exec-wake brings genuinely new input (a process completed); a `send`
// continuation brings none (the agent scheduled itself).
function buildAutonomousRunLine(context = {}) {
  let frame = context.frame || {};
  let continuation = frame.continuation || {};
  let depth = Number(frame.continuationDepth) || Number(continuation.continuationDepth) || 0;
  if (!Number.isFinite(depth) || depth <= 0)
    return '';

  let newness = continuation.kind === 'exec-wake-on-completion'
    ? 'A process you started has completed.'
    : 'No new input since your last step.';
  return `(Autonomous run — step ${Math.trunc(depth)}. ${newness})`;
}

function resolveSessionGeneration(context = {}) {
  if (context.sessionGeneration != null)
    return context.sessionGeneration;

  return sessionGeneration(context.session);
}

function buildDelegationBriefLines(sessionGeneration) {
  if (normalizeSessionGeneration(sessionGeneration) > 0) {
    return [
      '- Delegation: this is a delegated child session. Do not create more sessions',
      '  and do not invite agents. Use session-message/session-frames/session-search',
      '  with session_id to coordinate.',
    ];
  }

  return [
    '- Delegation: for sub-agent work use session-create(includeSelf), then',
    '  session-invite-agents, session-message (explicit session_id), session-frames; audit names/paths',
    '  against the current routed message before any handoff.',
  ];
}

function resolveBriefSender(context = {}) {
  for (let value of [
    context.frame?.authorDisplayName,
    resolveParticipantName(context, context.frame?.authorID),
    context.frame?.content?.agentName,
    context.frame?.authorID,
  ]) {
    let normalized = normalizeBriefString(value);
    if (normalized)
      return normalized;
  }

  return context.frame?.authorType === 'user' ? 'User' : 'System';
}

// Frame timestamps are Unix MICROseconds (HybridLogicalClock/defaultUnixMicros),
// while `Date` expects milliseconds. Anything at or above the microsecond
// threshold is scaled down; smaller values are treated as milliseconds.
const MICROSECOND_TIMESTAMP_THRESHOLD = 100_000_000_000_000;

function resolveBriefTimestamp(context = {}) {
  let raw = context.frame?.timestamp ?? context.frame?.createdAt ?? null;
  if (raw == null)
    return new Date().toISOString();

  let value = Number(raw);
  if (!Number.isFinite(value))
    return '';

  let milliseconds = value >= MICROSECOND_TIMESTAMP_THRESHOLD
    ? Math.floor(value / 1000)
    : Math.trunc(value);
  let date = new Date(milliseconds);
  if (Number.isNaN(date.getTime()))
    return '';

  return date.toISOString();
}

// Open questions the agent is still waiting on, so it does not re-ask them.
function resolveBriefQuestions(context = {}) {
  let ids = context.questionsState?.ids;
  if (!Array.isArray(ids) || ids.length === 0)
    return '';

  let summaries = Array.isArray(context.questionsState?.summaries) ? context.questionsState.summaries : [];
  let first = summaries.find((entry) => typeof entry?.text === 'string' && entry.text.trim() !== '');
  let label = first ? ` (oldest: ${truncateQuestionText(first.text)})` : '';

  return `${ids.length} question(s) awaiting the user${label}`;
}

function truncateQuestionText(text) {
  let normalized = String(text).trim().replace(/\s+/g, ' ');
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function resolveBriefTodo(context = {}) {
  let items = context.todoState?.items;
  if (!Array.isArray(items) || items.length === 0)
    return 'none';

  let focus = normalizeBriefString(context.todoState?.focus?.name);
  let names = items
    .filter((item) => normalizeBriefString(item?.title) !== '')
    .slice(0, 6)
    .map((item) => `${item.status === 'complete' ? '[done] ' : ''}${normalizeBriefString(item.title)}`);
  let parts = [ `${items.length} item(s)` ];
  if (focus)
    parts.push(`focus: ${focus}`);
  if (names.length > 0)
    parts.push(`items: ${names.join(' | ')}`);

  return parts.join('; ');
}

function formatBriefPartyLines(context = {}) {
  let { agents, users } = collectPartyActors(context);
  let lines = [];

  for (let agent of agents) {
    let coordinator = agent.isCoordinator ? ' - Coordinator' : '';
    lines.push(`         ${lines.length + 1}. [${agent.name}](@${agent.id})${coordinator}`);
  }

  for (let userID of users)
    lines.push(`         ${lines.length + 1}. ${userID}`);

  if (lines.length === 0)
    return 'none';

  return lines.join('\n');
}

function normalizeBriefString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSessionGeneration(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return 0;

  return Math.trunc(number);
}
