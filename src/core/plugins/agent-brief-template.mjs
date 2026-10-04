'use strict';

// Two-tier brief builders (P2). Pure functions: each returns `{ text }` and has
// no side effects. Brief A is sent ONCE per (re)start; Brief B every turn and
// every tool round. Providers stay ignorant of the split — the model-context
// assembly decides the emitted message shape.

import {
  AGIS_PRECEPTS_LINES,
  COORDINATOR_PREAMBLE_LINES,
  MULTIPARTY_CHARACTER_NOTE_LINES,
  STANDARD_BEHAVIOR_LINES,
  STANDARD_TOOL_NOTES_LINES,
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
  '  turn:      end-turn (with a report, or silent), continue-turn',
  '             (keep working, wake later), progress',
  '  route:     route (coordinator only)',
  '  control:   stop, set-character',
  '  help:      help (lists all tools; each tool has its own help)',
  '  work:      read-file, write-file, exec, fetch, search, feedback-report',
  '  session:   session-create, session-invite-agents, session-message,',
  '             session-frames, session-search, agent-list',
  '  state:     todo-*, cwd-*',
];

function buildBriefToolLines(_context = {}) {
  return [ 'Tools:', ...BRIEF_TOOL_LINES_COMMON ];
}

// The turn-ending phrase (dual verb). It carries the queue-as-definition-of-done
// rule and biases toward continuing: uncertainty is a reason to keep working,
// not to stop. This is the whole per-turn contract for ending a turn.
export const TURN_ENDING_LINES = [
  'End every turn one of two ways:',
  '- end-turn — with a report for the user — when your queue is empty.',
  '- continue-turn — with the next thing you\'re going to work on — when it isn\'t.',
  'If you don\'t know the next step yet, keep working to plan it out.',
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

// Brief B ("message brief") — sent EVERY turn and every tool round.
export function buildMessageBrief(context = {}) {
  let sender = resolveBriefSender(context);
  let stamp = resolveBriefTimestamp(context);
  let message = normalizeBriefString(context.messageText) || normalizeBriefString(context.frame?.content?.text);
  let todo = resolveBriefTodo(context);
  let cwd = normalizeBriefString(context.cwdState?.cwd || context.cwd) || 'none';
  let coordinator = context.isCoordinator === true;
  let parties = formatBriefPartyLines(context);
  let autonomous = buildAutonomousRunLine(context);

  return {
    text: [
      `Message from ${sender} ${stamp}:`,
      message,
      '',
      `todo:    ${todo}`,
      `cwd:     ${cwd}`,
      `coord:   ${coordinator}`,
      `parties: ${parties}`,
      ...(autonomous ? [ '', autonomous ] : []),
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
    '  session-invite-agents, session-message, session-frames; audit names/paths',
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

function resolveBriefTodo(context = {}) {
  let items = context.todoState?.items;
  if (!Array.isArray(items) || items.length === 0)
    return 'none';

  return `${items.length} item(s); review with todo.list`;
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
