'use strict';

import { resolveCoordinatorChain } from './coordinator-scope.mjs';
import { postAgentSessionMessage } from '../tools/session-tool-helpers.mjs';

const MAX_ANCESTOR_DEPTH = 64;

// Build the visible message the coordinator receives. The coordinator gets the
// stopped bot's completed summary plus an explicit validation obligation: the
// stop message is a signal to check the work, not proof that the work is done.
export function buildEndTurnNotice({ agentID, sessionID, summary } = {}) {
  let bot = normalizeID(agentID) || '(unknown bot)';
  let session = normalizeID(sessionID) || '(unknown session)';
  let message = typeof summary === 'string' && summary.trim() !== ''
    ? summary.trim()
    : '(The bot ended its turn without a visible summary.)';

  return [
    `Bot ${bot} in session ${session} has stopped. It is either finished with its work, or needs assistance. Please check in on it. It finished its turn with the message:`,
    message,
    '',
    'Coordinator validation required: prove that all of the bot\'s work is complete and that no gaps remain. List the hypotheticals, unknowns, impossible cases, not-thought-of cases, and edge cases that you tested, verified, and have proof for, as a bulleted list of all checks you performed. If you cannot prove a claim, steer the bot or resume the work.',
  ].join('\n');
}

// Find the nearest coordinator in the authority chain that is not the bot
// ending its turn, then post the notice into that coordinator's session. A bot
// that is already the highest coordinator has nobody above it to notify, so the
// operation is skipped entirely rather than messaging itself.
export async function notifyCoordinatorOfEndTurn({
  context = {},
  summary = '',
  details = '',
  postMessage = postAgentSessionMessage,
} = {}) {
  let agentID = normalizeID(context.agent?.id);
  let session = context.session;
  let sessionID = normalizeID(session?.id);
  let message = normalizeID(summary) || normalizeID(details);
  if (!agentID || !sessionID || !message)
    return { posted: false, reason: 'missing-context' };

  let runtime = resolveFrameRuntime(context);
  if (!runtime)
    return { posted: false, reason: 'missing-frame-runtime' };

  let sessions = await loadSessionChain(runtime, session);
  let chain = resolveCoordinatorChain({
    sessionID,
    getSession: (id) => sessions.get(id) || runtime.getSession?.(id) || null,
  });

  let target = chain.chain.find((entry) => normalizeID(entry.agentID) && entry.agentID !== agentID);
  if (!target)
    return { posted: false, reason: 'no-parent-coordinator', coordinatorChain: chain.chain };

  let text = buildEndTurnNotice({ agentID, sessionID, summary: message });
  let result = await postMessage({
    runtime,
    context,
    sessionID: target.sessionID,
    targetAgentID: target.agentID,
    text,
    sourceSessionID: sessionID,
    sourceFrameID: context.frame?.id || null,
  });

  return {
    posted: true,
    coordinatorAgentID: target.agentID,
    coordinatorSessionID: target.sessionID,
    frameID: result?.frame?.id || null,
  };
}

async function loadSessionChain(runtime, session) {
  let sessions = new Map();
  let current = normalizeID(session?.id);
  let seen = new Set();

  if (current)
    sessions.set(current, session);

  for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (seen.has(current))
      break;

    seen.add(current);

    if (!sessions.has(current)) {
      let loaded = await loadSession(runtime, current);
      if (loaded)
        sessions.set(current, loaded);
    }

    let record = sessions.get(current);
    if (!record)
      break;

    current = normalizeID(record.parentSessionID || record.parentSessionId);
  }

  return sessions;
}

async function loadSession(runtime, sessionID) {
  if (typeof runtime.ensureSessionEntry === 'function') {
    try {
      let entry = await runtime.ensureSessionEntry(sessionID, { loadFrames: false });
      if (entry?.session)
        return entry.session;
    } catch (_error) {
      // Fall through to the read-only lookup below.
    }
  }

  if (typeof runtime.frameStore?.loadSession === 'function') {
    try {
      return await runtime.frameStore.loadSession(sessionID);
    } catch (_error) {
      return null;
    }
  }

  return typeof runtime.getSession === 'function' ? runtime.getSession(sessionID) : null;
}

function resolveFrameRuntime(context = {}) {
  if (context.frameRuntime)
    return context.frameRuntime;

  if (context.services?.frameRuntime)
    return context.services.frameRuntime;

  let appContext = context.services?.context || context.context;
  if (appContext?.has?.('frameRuntime') && typeof appContext.require === 'function')
    return appContext.require('frameRuntime');

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require('frameRuntime');
    } catch (_error) {}
  }

  return null;
}

function normalizeID(value) {
  return typeof value === 'string' ? value.trim() : '';
}
