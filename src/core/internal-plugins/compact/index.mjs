'use strict';

import CompactionRunner from '../../compaction/index.mjs';

// =============================================================================
// Compact Capability Plugin
// =============================================================================
// Registers `compact` capability — unified slash command + tool.
// Manually triggers compaction of the session's conversation history.
// Compaction is AWAITED (blocking) since the user explicitly requested it.
//
// Invocable as:
//   - Slash command: /compact
//   - Tool call:     { toolName: 'compact', arguments: {} }
// =============================================================================

export function setup(provide) {
  provide(({ registry, context }) => {
    registry.registerCapability('compact', {
      description:  'Compact session history by summarizing older messages. Frees context window space.',
      displayName:  'Compact History',
      riskLevel:    'low',
      slashCommand: 'compact',
      schema: {
        type:       'object',
        properties: {},
      },
      examples: [
        { input: '/compact', description: 'Compact the current session\'s conversation history' },
      ],

      async handler({ sessionID, context: ctx, agent }) {
        // 1. Validate agent
        if (!agent || !agent.pluginID) {
          return {
            content: { html: '<p>No agent found for compaction.</p>' },
          };
        }

        // 2. Get dependencies from context
        let pluginRegistry  = ctx.getProperty('pluginRegistry');
        let sessionManager  = ctx.getProperty('sessionManager');
        let framePersistence = ctx.getProperty('framePersistence');

        if (!pluginRegistry || !sessionManager) {
          return {
            content: { html: '<p>Compaction failed: required services not available.</p>' },
          };
        }

        // 3. Get the agent plugin class and instantiate
        let AgentClass = pluginRegistry.getAgentType(agent.pluginID);
        if (!AgentClass) {
          return {
            content: { html: '<p>No agent plugin found for compaction.</p>' },
          };
        }

        let plugin = new AgentClass(ctx);

        // 4. Get the FrameManager and load frames
        let frameManager = sessionManager.getFrameManager(sessionID);

        if (framePersistence)
          await framePersistence.loadFramesInto(frameManager, sessionID);

        // 5. Check for active compaction
        let runner   = new CompactionRunner({ logger: console });
        let canStart = await runner.canStartCompaction(sessionID, frameManager);

        if (!canStart) {
          return {
            content: { html: '<p>Compaction already in progress.</p>' },
          };
        }

        // 6. Run compaction — AWAIT since user explicitly requested it
        let frameID = await runner.runCompaction(sessionID, {
          agent,
          plugin,
          frameManager,
        });

        // 7. Evaluate result
        if (frameID === null) {
          // Check if session had no frames to compact
          let compactable = frameManager.toArray().filter((f) => f.type !== 'compaction' && !f.deleted);

          if (compactable.length === 0) {
            return {
              content: { html: '<p>Nothing to compact. Session has no messages.</p>' },
            };
          }

          return {
            content: { html: '<p>Compaction failed. The session history could not be compressed.</p>' },
          };
        }

        return {
          content: { html: '<p>Compaction complete.</p>' },
        };
      },
    });
  });

  return () => {};
}
