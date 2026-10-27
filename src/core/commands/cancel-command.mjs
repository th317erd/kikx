'use strict';

import { parseCommandTarget } from './command-target.mjs';
import { describeHaltResult, haltSessionTree } from '../agents/coordinator-tree-halt.mjs';

// `/cancel`, `/stop`, `/suspend` and `/halt` are one command (the aliases below).
// Requirement 4 is therefore about REACH, not aliasing: the command must be able
// to name a session other than the caller's own, and it must be issuable by a bot
// when that bot holds coordinator authority.
//
// Forms:
//   /halt                      -> the caller's own session
//   /halt <agent>              -> that agent, in the caller's own session
//   /halt session:<id>         -> that session (or, by default, its whole subtree)
//   /halt <id>                 -> the same, for an argument that names a session
export class CancelCommand {
  static description = 'Suspend agent turns and pause their in-flight commands. '
    + 'Usage: /cancel [agent] or /cancel session:<sessionId> [agent]';
  static aliases = [ 'stop', 'suspend', 'halt' ];

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ args, frame, services }) {
    let frameRuntime = services?.frameRuntime || services?.context?.require?.('frameRuntime');
    let agentManager = services?.agentManager || services?.context?.require?.('agentManager');
    let processManager = services?.processManager || services?.context?.require?.('processManager');

    let parsedArgs = parseCancelArgs(args);

    // Who is asking? A human frame runs as the session's coordinator by
    // convention; a bot must be the coordinator of the target or an ancestor.
    let isHuman = frame?.authorType !== 'agent';
    let actorAgentID = isHuman
      ? null
      : (frame?.authorID || this.context?.agent?.id || null);

    let currentSessionID = frame?.sessionID || this.context?.session?.id || null;
    let targetSessionID = parsedArgs.sessionID || currentSessionID;

    // For a human, the pre-existing behaviour is preserved exactly: halt the
    // named agent (or everything) in the session they are looking at. Reach into
    // another session is a coordinator power, so an unnamed target keeps the old
    // path and an explicitly named one goes through the authority check below.
    if (isHuman && !parsedArgs.sessionID) {
      return await cancelLocally({
        sessionID: currentSessionID,
        target: parsedArgs.target,
        frameRuntime,
        agentManager,
        processManager,
      });
    }

    let result = await haltSessionTree({
      actorAgentID,
      targetSessionID,
      currentSessionID,
      includeSubtree: parsedArgs.includeSubtree,
      target: parsedArgs.target,
      reason: isHuman ? 'user-suspend' : 'coordinator-halt',
      services: {
        frameRuntime,
        agentManager,
        processManager,
        listSessions: () => frameRuntime?.listSessions?.({ limit: 500 }) || [],
      },
    });

    return {
      status: result.allowed ? 'ok' : 'error',
      message: describeHaltResult(result),
      data: result,
    };
  }
}

/**
 * The unchanged single-session path for a human pressing STOP in the session they
 * are looking at. Kept separate so the coordinator path above cannot alter the
 * behaviour the owner already relies on.
 */
async function cancelLocally({ sessionID, target, frameRuntime, agentManager, processManager }) {
  let { suspendSessionAgents } = await import('../agents/agent-cancellation.mjs').catch(() => ({}));
  if (typeof suspendSessionAgents !== 'function')
    throw new Error('/cancel is unavailable: agent cancellation could not be loaded');

  let reference = typeof target === 'string' && target.trim() !== ''
    ? parseCommandTarget(target, {
      command: '/cancel',
      usage: 'Usage: /cancel [agent]',
      quoteUsage: 'Usage: /cancel "agent name"',
      allowedTypes: [ 'agent' ],
      disallowedMessage: '/cancel can only target an agent; teams are not active runs.',
    }).reference
    : null;

  let result = await suspendSessionAgents({
    sessionID,
    target: reference,
    frameRuntime,
    agentManager,
    processManager,
  });

  let message = result.count === 0
    ? (result.target ? `No active run for ${result.target}.` : 'No active agent runs.')
    : (result.target
      ? `Suspension requested for ${result.target}.`
      : `Suspension requested for ${result.count} active agent${result.count === 1 ? '' : 's'}.`);

  return {
    status: 'ok',
    message,
    data: result,
  };
}

/**
 * Split the argument string into an optional `session:<id>` prefix, an optional
 * agent target, and the subtree switch.
 *
 * `!` before the session id means "this session only, do not fan out", mirroring
 * how an operator expects to narrow a recursive command.
 */
export function parseCancelArgs(args) {
  let rest = typeof args === 'string' ? args.trim() : '';
  let sessionID = null;
  let includeSubtree = true;

  if (rest === '')
    return { sessionID, target: null, includeSubtree };

  let match = rest.match(/^session:(\S+)\s*([\s\S]*)$/i);
  if (match) {
    let reference = match[1].trim();
    if (reference.startsWith('!')) {
      includeSubtree = false;
      reference = reference.slice(1);
    }
    sessionID = reference || null;
    rest = (match[2] || '').trim();
  }

  return {
    sessionID,
    target: rest === '' ? null : rest,
    includeSubtree,
  };
}
