'use strict';

import { normalizeOptionalPromptString } from './agent-normalizers.mjs';
import {
  isCoordinatedMentionTarget,
  resolveParticipantName,
} from './agent-participants.mjs';

export function normalizeTokenUsagePromptContext(context = {}) {
  let tokenUsage = (context.tokenUsage && typeof context.tokenUsage === 'object' && !Array.isArray(context.tokenUsage))
    ? context.tokenUsage
    : {};
  let total = Number(context.totalTokensUsed);
  if (!Number.isFinite(total) || total < 0)
    total = totalTokensUsed(tokenUsage);

  return {
    totalTokensUsed: Math.trunc(total),
    services: tokenUsage,
  };
}

export function normalizeTodoPromptContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  return {
    agentID: typeof value.agentID === 'string' ? value.agentID : null,
    items: Array.isArray(value.items) ? value.items : [],
    focus: value.focus && typeof value.focus === 'object' && !Array.isArray(value.focus)
      ? value.focus
      : null,
    updatedAt: value.updatedAt || null,
  };
}

export function normalizeCwdPromptContext(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    return {
      cwd: value.trim(),
      configured: true,
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  return {
    cwd: typeof value.cwd === 'string' ? value.cwd.trim() : '',
    configured: value.configured === true,
    updatedAt: value.updatedAt || null,
  };
}

export function totalTokensUsed(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot || {})) {
    let value = Number(entry?.tokensUsed);
    if (Number.isFinite(value) && value > 0)
      total += Math.trunc(value);
  }

  return total;
}

export function buildRoutingPromptLines(context = {}) {
  if (context.isCoordinator === true) {
    let lines = [
      'If you are the coordinator, then you are the preferred agent. You evaluate first, and you are usually the best agent to answer broad, general, or ambiguous messages.',
      'Recipient decision checklist: ask "Who is this message really for: me, another session agent, the user, or everyone?" before answering.',
      'Use turn-taking: if the immediately prior visible response came from another agent and the user asks a follow-up with "you", "your", or a short ambiguous question, treat it as meant for that prior agent unless the user clearly redirects to you.',
      'If this message is not for you based on mentions, names, nicknames, turn-taking, or recent context, use agent-null-response and stay silent.',
      'Do not answer on behalf of another session agent just because you are the coordinator.',
      'Keep internal-forward available only for explicit forwarding workflows, such as external services or future sleeper agents; do not use it as normal intra-session handoff.',
      'If the message is targeted to you, deeply consider it in the context of the available user and project rules.',
    ];

    if (context.frame?.authorType === 'agent') {
      lines.splice(3, 0,
        'This is an agent-authored message in the shared session. Answer only if that agent directly asks you, mentions you, delegates to you, or your contribution is clearly needed.',
      );
    }

    return lines;
  }

  if (context.frame?.coordinated === true) {
    if (isCoordinatedMentionTarget(context)) {
      return [
        'You are not the coordinator. This frame has already been coordinated and forwarded to you.',
        'You are an intended recipient; answer if it is for you.',
        'If this message is not for you after checking mentions, names, turn-taking, and recent context, use agent-null-response and stay silent.',
        'Do not forward it again.',
      ];
    }

    return [
      'You are not the coordinator. This frame has already been coordinated and forwarded to its mentioned recipients.',
      'You are not an intended recipient. Use agent-null-response and do not forward it again.',
    ];
  }

  return [
    'You are not the coordinator. Answer only when the message is targeted to you.',
    'If this message is not for you, use agent-null-response and let routing continue elsewhere.',
  ];
}

export function buildTriggerFramePromptLines(context = {}) {
  let frame = context.frame || {};
  if (frame.continuation?.kind === 'agent-respond-and-continue' || frame.authorID === 'internal:agent-continuation') {
    return [
      'Your scheduled respond-and-continue prompt has fired and this hidden continuation frame has been routed back to you:',
    ];
  }

  if (frame.continuation?.kind === 'exec-wake-on-completion' || frame.authorID === 'internal:process-manager') {
    return [
      'An async process you started has completed and this hidden completion wake frame has been routed back to you:',
    ];
  }

  if (frame.authorType === 'agent') {
    let label = normalizeOptionalPromptString(frame.authorDisplayName)
      || resolveParticipantName(context, frame.authorID)
      || normalizeOptionalPromptString(frame.authorID)
      || 'Unknown agent';
    let id = normalizeOptionalPromptString(frame.authorID);
    return [
      `Agent ${label}${id ? ` (${id})` : ''} has just sent a message:`,
    ];
  }

  if (frame.authorType === 'user') {
    let label = normalizeOptionalPromptString(frame.authorDisplayName)
      || normalizeOptionalPromptString(frame.authorID);
    return [
      label ? `User ${label} has just sent you a message:` : 'The user has just sent you a message:',
    ];
  }

  return [ 'A session frame has just been routed to you:' ];
}
