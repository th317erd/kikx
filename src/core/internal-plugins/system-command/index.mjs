'use strict';

import { SystemCommandPermissions } from './system-command-permissions.mjs';

// =============================================================================
// System Command Plugin
// =============================================================================
// Registers `system:command` tool that lets agents invoke slash commands
// through the tool-call protocol. The agent yields:
//   { type: 'ToolCall', content: { toolName: 'system:command', arguments: { command: 'invite', args: '@name' } } }
//
// The tool resolves the command handler from the plugin registry and
// executes it with the injected session context (_sessionID, _authorID, _agent).
// =============================================================================

/**
 * @param {(cb: (ctx: { registry: any, context: import('../../types').CascadingContext }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry, context }) => {
    let PluginInterface = registry.getClass('PluginInterface');

    class SystemCommandTool extends PluginInterface {
      static pluginID    = 'system';
      static featureName = 'command';
      static displayName = 'System Command';
      static description = 'Execute slash commands on behalf of the agent';
      static riskLevel   = 'high';
      static inputSchema = {
        type:       'object',
        properties: {
          command: { type: 'string', description: 'The slash command name (without the leading /)' },
          args:    { type: 'string', description: 'Arguments to pass to the command' },
        },
        required: ['command'],
      };

      getPermissionsClass() {
        return SystemCommandPermissions;
      }

      /**
       * @param {{ command: string, args?: string, _sessionID?: string, _authorID?: string, _agent?: import('../../types').Agent }} params
       * @returns {Promise<{ html: string, injectPrimer?: boolean, commandName?: string }>}
       */
      async _execute({ command, args, _sessionID, _authorID, _agent }) {
        if (!command || typeof command !== 'string')
          return { html: '<p>Error: <code>command</code> is required and must be a string.</p>' };

        let commandName = command.toLowerCase().trim();
        let reg         = this._context.getProperty('pluginRegistry');

        if (!reg)
          return { html: '<p>Error: plugin registry not available.</p>' };

        // Try traditional command first, then capability by slash command
        let handler    = reg.getCommand(commandName);
        let capability = !handler ? reg.getCapabilityBySlashCommand(commandName) : null;

        if (!handler && !capability)
          return { html: `<p>Unknown command: <code>/${commandName}</code></p>` };

        try {
          let result;

          if (capability) {
            // Execute as capability — parse args if parseArgs is available
            let structuredParams;

            if (typeof capability.parseArgs === 'function')
              structuredParams = capability.parseArgs(args || '');
            else
              structuredParams = { text: args || '' };

            if (!structuredParams)
              return { html: `<p>Usage: <code>/${commandName}</code> — could not parse arguments.</p>` };

            result = await capability.handler({
              params:     structuredParams,
              sessionID:  _sessionID,
              context:    this._context,
              authorType: 'agent',
              authorID:   _authorID || null,
              agent:      _agent || null,
            });
          } else {
            result = await handler({
              sessionID:  _sessionID,
              arguments:  args || '',
              context:    this._context,
              authorType: 'agent',
              authorID:   _authorID || null,
              agent:      _agent || null,
            });
          }

          let content     = (result && result.content) || { html: '<p>Command executed.</p>' };
          let injectPrimer = !!(result && result.injectPrimer);

          return {
            html:         content.html,
            injectPrimer,
            commandName,
          };
        } catch (error) {
          return { html: `<p>Command error: ${error.message}</p>` };
        }
      }

      getHelp() {
        return {
          ...super.getHelp(),
          inputSchema: SystemCommandTool.inputSchema,
          usage:       'system:command { command: "invite", args: "@agent-name" }',
          examples:    [
            { command: 'reload', args: '',              description: 'Reload agent instructions' },
            { command: 'invite', args: '@test-claude',  description: 'Invite an agent to the session' },
            { command: 'help',   args: '',              description: 'List all available commands and tools' },
          ],
        };
      }
    }

    registry.registerTool('system:command', SystemCommandTool);

    registry.registerInstructions(
      'system-command',
      'Some capabilities are available as direct tools: `invite` (invite an agent, e.g. `{ agentName: "agent-name" }`) ' +
      'and `reload` (reload instructions). Prefer calling these tools directly. ' +
      'For commands not yet available as direct tools, use the `system:command` bridge tool: ' +
      '`{ command: "help", args: "" }`. ' +
      'Do not use `system:command` in response to a user typing a slash command — the server handles those automatically.',
      { priority: 200 },
    );
  });

  return () => {};
}
