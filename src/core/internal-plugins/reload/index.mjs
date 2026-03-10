'use strict';

// =============================================================================
// Reload Capability Plugin
// =============================================================================
// Registers `reload` capability — unified slash command + tool.
// Flags the session to re-inject the primer (agent instructions)
// on the next user message.
//
// Invocable as:
//   - Slash command: /reload
//   - Tool call:     { toolName: 'reload', arguments: {} }
// =============================================================================

export function setup({ registerCapability }) {
  registerCapability('reload', {
    description:  'Reload the agent\'s instructions (primer). The primer will be re-injected with your next message.',
    displayName:  'Reload Instructions',
    riskLevel:    'low',
    slashCommand: 'reload',
    schema: {
      type:       'object',
      properties: {},
    },
    examples: [
      { input: '/reload', description: 'Force the agent to re-read its instructions on the next message' },
    ],
    async handler() {
      return {
        content:      { html: '<p>Instructions reloaded. They will be included with your next message.</p>' },
        injectPrimer: true,
      };
    },
  });

  return () => {};
}
