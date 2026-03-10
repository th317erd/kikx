'use strict';

// =============================================================================
// Invite Command Plugin
// =============================================================================
// Registers `/invite @agentName` command.
// Adds the named agent as a participant to the current session.
// The participant-joined frame is created by addParticipant() automatically.
// =============================================================================

export function setup({ registerCommand, context }) {
  registerCommand('invite', async ({ sessionID, arguments: argsString }) => {
    if (!argsString)
      return { content: { html: '<p>Usage: <code>/invite @agentName</code></p>' } };

    // Parse: @agentName
    let argMatch = argsString.match(/^@?([\w_-]+)/);
    if (!argMatch)
      return { content: { html: '<p>Usage: <code>/invite @agentName</code></p>' } };

    let agentName = argMatch[1];

    // Look up the agent
    let { Agent } = context.getProperty('models');
    let agent     = await Agent.where.name.EQ(agentName).first();

    if (!agent)
      return { content: { html: `<p>Agent not found: <strong>${agentName}</strong></p>` } };

    // Add as participant (creates participant-joined frame automatically)
    let sessionManager = context.getProperty('sessionManager');
    await sessionManager.addParticipant(sessionID, agent.id);

    return {
      content: { html: `<p>Invited <strong>${agentName}</strong> to this session.</p>` },
    };
  }, {
    description: 'Invite an agent to the current session as a participant.',
    usage:       '/invite @agentName',
    parameters:  [
      { name: 'agentName', required: true, description: 'The name of the agent to invite (with or without @ prefix)' },
    ],
    examples: [
      { input: '/invite @test-claude', description: 'Invite the test-claude agent' },
    ],
  });

  return () => {};
}
