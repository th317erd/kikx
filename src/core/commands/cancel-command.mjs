'use strict';

import { suspendSessionAgents } from '../agents/agent-cancellation.mjs';
import { parseCommandTarget } from './command-target.mjs';

export class CancelCommand {
  static description = 'Suspend agent turns and pause their in-flight commands. Usage: /cancel [agent]';
  static aliases = [ 'stop', 'suspend', 'halt' ];

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ args, frame, services }) {
    let frameRuntime = services?.frameRuntime || services?.context?.require?.('frameRuntime');
    let agentManager = services?.agentManager || services?.context?.require?.('agentManager');
    let processManager = services?.processManager || services?.context?.require?.('processManager');
    let target = args?.trim()
      ? parseCommandTarget(args, {
        command: '/cancel',
        usage: 'Usage: /cancel [agent]',
        quoteUsage: 'Usage: /cancel "agent name"',
        allowedTypes: [ 'agent' ],
        disallowedMessage: '/cancel can only target an agent; teams are not active runs.',
      }).reference
      : null;

    let result = await suspendSessionAgents({
      sessionID: frame.sessionID,
      target,
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
}
