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
      'You are the coordinator and the router for this session. Every message reaches you so you can decide what happens next. You are the default handler for broad, general, or ambiguous user messages, but you must NOT answer messages that are meant for another actor.',
      'Decide in this order:',
      '1) Explicitly addressed to another actor (a @mention, a name, or a clear "ask X" instruction, even misspelled): use the route tool to tag that actor, then stay silent. Do not answer it yourself.',
      '2) Explicitly addressed to you (your name/mention, or a reply to your own message): answer normally.',
      '3) A broad, unaddressed user message: answer it yourself as the default handler.',
      '4) Clearly best handled by a specialist present in the session (by skills, knowledge, or role): route it to them and stay silent.',
      '5) An agent reply that already satisfies the open request: stay silent. Do not acknowledge or repeat it.',
      '6) An agent reply that asks you something, needs a decision, or addresses you: answer or route as appropriate.',
      'Otherwise: stay silent.',
      'Routing means tagging recipients with the route tool; you may also remove a recipient the user tagged by mistake. Routing never produces a visible message from you, so do not both route and answer the same message.',
      'You may route to more than one actor when several are genuinely needed.',
      'Use turn-taking: if the immediately prior visible response came from another agent and the user asks a short follow-up with "you"/"your", treat it as meant for that agent unless the user clearly redirects.',
      'Stay silent (agent-null-response) whenever you are not the right responder; silence is the safe default.',
    ];

    if (context.frame?.authorType === 'agent') {
      lines.splice(2, 0,
        'This message was authored by another agent. The exchange is usually complete once an agent has answered; prefer silence unless that agent asks you something or a decision is genuinely needed.',
      );
    }

    return lines;
  }

  if (context.frame?.coordinated === true) {
    if (isCoordinatedMentionTarget(context)) {
      return [
        'You are not the coordinator. The coordinator has routed this message to you.',
        'You are an intended recipient; answer if it is for you.',
        'If this message is not for you after checking the recipient list, mentions, names, turn-taking, and recent context, use agent-null-response and stay silent.',
        'Do not route or forward it again.',
      ];
    }

    return [
      'You are not the coordinator. This message was routed to other actors, not you.',
      'You are not an intended recipient. Use agent-null-response and stay silent. Do not route or forward it again.',
    ];
  }

  return [
    'You are not the coordinator. Answer only when the message is routed or addressed to you.',
    'If this message is not for you, use agent-null-response and let the coordinator route it.',
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
