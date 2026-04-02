'use strict';

// =============================================================================
// Invite Capability Plugin
// =============================================================================
// Registers `invite` capability — unified slash command + tool.
// Adds the named agent as a participant to the current session.
// The participant-joined frame is created by addParticipant() automatically.
//
// Invocable as:
//   - Slash command: /invite @agentName
//   - Tool call:     { toolName: 'invite', arguments: { agentName: 'name' } }
// =============================================================================

/**
 * @param {(cb: (ctx: { registry: any, context: import('../../types').CascadingContext }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry, context }) => {
    registry.registerCapability('invite', {
      description:  'Invite an agent to the current session as a participant.',
      displayName:  'Invite Agent',
      riskLevel:    'high',
      slashCommand: 'invite',
      schema: {
        type:       'object',
        properties: {
          agentName: {
            type:        'string',
            description: 'The name of the agent to invite (without @ prefix)',
          },
        },
        required: ['agentName'],
      },
      parseArgs(rawString) {
        if (!rawString)
          return null;

        let trimmed = rawString.trim();

        // Support quoted names: /invite "Gemini Krickets" or /invite 'Gemini Krickets'
        let quotedMatch = trimmed.match(/^@?["'](.+?)["']/);
        if (quotedMatch)
          return { agentName: quotedMatch[1] };

        // Unquoted: treat the entire remaining string as the name
        // (strip leading @ if present)
        let name = trimmed.replace(/^@/, '').trim();
        if (!name)
          return null;

        return { agentName: name };
      },
      examples: [
        { input: '/invite @test-claude', description: 'Invite the test-claude agent' },
        { tool:  '{ agentName: "test-claude" }', description: 'Invite via tool call' },
      ],
      /**
       * @param {{ params: { agentName: string }, sessionID: string }} handlerArgs
       * @returns {Promise<{ content: { html: string } }>}
       */
      async handler({ params, sessionID }) {
        let agentName = params.agentName;

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
      },
    });
  });

  return () => {};
}
