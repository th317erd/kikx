'use strict';

export class InviteCommand {
  static description = 'Invite an agent into the current session.';

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ args, frame, services }) {
    let reference = normalizeAgentReference(args);
    let agentManager = services?.agentManager || services?.context?.require?.('agentManager');
    let frameRuntime = services?.frameRuntime || services?.context?.require?.('frameRuntime');

    if (!agentManager)
      throw new Error('/invite requires an agent manager');

    if (!frameRuntime)
      throw new Error('/invite requires a frame runtime');

    let agent = await agentManager.resolveAgent(reference);
    let result = await frameRuntime.inviteAgentToSession(frame.sessionID, agent, {
      invitedByUserID: frame.authorID || null,
      invitedAt: frame.timestamp || frame.createdAt || services?.clock?.() || Date.now(),
    });

    return {
      status: result.alreadyParticipant ? 'ok' : 'ok',
      message: result.alreadyParticipant
        ? `${agent.name} is already in this session.`
        : `${agent.name} joined this session.`,
      data: {
        agentID: agent.id,
        agentName: agent.name,
        alreadyParticipant: result.alreadyParticipant,
      },
    };
  }
}

function normalizeAgentReference(args) {
  if (typeof args !== 'string' || args.trim() === '')
    throw new Error('Usage: /invite agent-name');

  return args.trim();
}
