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

// P8.3: language that nudges a model to hurry, stop early, or act out of fear
// of missing out. The two-tier briefs must never reintroduce it; the brief
// spec greps both assembled briefs against this explicit denylist. Matched
// case-insensitively with word boundaries (so "stops serving" is not flagged
// by the `stop` entry).
export const BRIEF_FORBIDDEN_PHRASES = [
  'prefer completing the task in one turn',
  'complete the task in one turn',
  'fear of missing out',
  'stop',
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
  '  finalize:  agent-respond, agent-finalize',
  '  yield:     agent-respond-and-continue',
  '  progress:  agent-progress',
  '  route:     route (coordinator only)',
  '  control:   loop-break, agent-character-set',
  '  help:      help (lists all tools; each tool has its own help)',
  '  work:      read-file, write-file, exec, fetch, search, feedback-report',
  '  session:   session-create, session-invite-agents, session-message,',
  '             session-frames, session-search, agent-list',
  '  state:     todo-*, cwd-*',
];

// The silence tool is only advertised with 3+ parties (its exposure rule also
// lives in `shouldExposeLoopTool`). Below that, neither the tool map nor the
// briefs mention agent-null-response at all.
const BRIEF_TOOL_LINES_SILENCE = [ '  silence:   agent-null-response' ];

function buildBriefToolLines(context = {}) {
  if (hasCoordinatorParties(context))
    return [ 'Tools:', BRIEF_TOOL_LINES_SILENCE[0], ...BRIEF_TOOL_LINES_COMMON ];

  return [ 'Tools:', ...BRIEF_TOOL_LINES_COMMON ];
}

function buildMessageBriefAnswerLine(context = {}) {
  if (hasCoordinatorParties(context))
    return 'Answer, or agent-null-response to stay silent.';

  return 'Answer the message.';
}

// AGIS precept lines reference the silence tool; drop the ones that mention it
// when the tool is not offered (below 3 parties).
function buildBriefPreceptLines(context = {}) {
  if (hasCoordinatorParties(context))
    return AGIS_PRECEPTS_LINES;

  return AGIS_PRECEPTS_LINES.filter((line) => !/agent-null-response/.test(line));
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
  let intro = canStaySilent
    ? [
      'Act as a careful, technically rigorous agent. Decide whether to answer, stay',
      'silent, or route. Feel free to use any tools as-needed. Never claim work your own',
      'tool frames do not show; always leave a truth/proof artifact.',
    ]
    : [
      'Act as a careful, technically rigorous agent. Answer the message, using any tools',
      'as-needed. Never claim work your own tool frames do not show; always leave a',
      'truth/proof artifact.',
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

  return {
    text: [
      `Message from ${sender} ${stamp}:`,
      message,
      '',
      `todo:    ${todo}`,
      `cwd:     ${cwd}`,
      `coord:   ${coordinator}`,
      `parties: ${parties}`,
      '',
      buildMessageBriefAnswerLine(context),
    ].join('\n'),
  };
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

function resolveBriefTimestamp(context = {}) {
  let raw = context.frame?.timestamp ?? context.frame?.createdAt ?? null;
  let date = raw == null ? new Date() : new Date(Number(raw) || raw);
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
