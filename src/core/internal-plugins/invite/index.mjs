'use strict';

// =============================================================================
// Invite Command Plugin
// =============================================================================
// Registers `/invite @agentName [as Alias]` command.
// Adds the named agent as a participant to the current session.
// =============================================================================

export function setup({ registerCommand, context }) {
  registerCommand('invite', async ({ sessionID, arguments: argsString }) => {
    if (!argsString)
      return { content: { html: '<p>Usage: <code>/invite @agentName [as Alias]</code></p>' } };

    // Parse: @agentName [as Alias] [extra...]
    let argMatch = argsString.match(/^@?([\w_-]+)(?:\s+as\s+(\S+))?/i);
    if (!argMatch)
      return { content: { html: '<p>Usage: <code>/invite @agentName [as Alias]</code></p>' } };

    let agentName = argMatch[1];
    let alias     = argMatch[2] || null;

    // Look up the agent
    let { Agent } = context.getProperty('models');
    let agent     = await Agent.where.name.EQ(agentName).first();

    if (!agent)
      return { content: { html: `<p>Agent not found: <strong>${agentName}</strong></p>` } };

    // Add as participant
    let sessionManager = context.getProperty('sessionManager');
    await sessionManager.addParticipant(sessionID, agent.id, { alias });

    let aliasNote = alias ? ` as <em>${alias}</em>` : '';
    return {
      content: { html: `<p>Invited <strong>${agentName}</strong>${aliasNote} to this session.</p>` },
    };
  }, {
    description: 'Invite an agent to the current session as a participant.',
    usage:       '/invite @agentName [as Alias]',
    parameters:  [
      { name: 'agentName', required: true, description: 'The name of the agent to invite (with or without @ prefix)' },
      { name: 'as Alias',  required: false, description: 'Optional display alias for the agent in this session' },
    ],
    examples: [
      { input: '/invite @test-claude',            description: 'Invite the test-claude agent' },
      { input: '/invite @test-claude as Assistant', description: 'Invite test-claude with display name "Assistant"' },
    ],
  });

  return () => {};
}
