'use strict';

// =============================================================================
// Reload Command Plugin
// =============================================================================
// Registers `/reload` command. Flags the session to re-inject the primer
// (agent instructions) on the next user message.
// =============================================================================

export function setup({ registerCommand }) {
  registerCommand('reload', async () => {
    return {
      content:      { html: '<p>Instructions reloaded. They will be included with your next message.</p>' },
      injectPrimer: true,
    };
  }, {
    description: 'Reload the agent\'s instructions (primer). The primer will be re-injected with your next message.',
    usage:       '/reload',
    examples:    [
      { input: '/reload', description: 'Force the agent to re-read its instructions on the next message' },
    ],
  });

  return () => {};
}
