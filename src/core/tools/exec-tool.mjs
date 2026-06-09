'use strict';

import { PluginInterface } from '../plugins/index.mjs';

export class ExecTool extends PluginInterface {
  static pluginID = 'internal:command';
  static featureName = 'exec';
  static displayName = 'Execute command';
  static description = 'Execute a local shell command through the Kikx server process login shell.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command to execute in the Kikx server process login shell.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory. Relative paths resolve from the Kikx server working directory.',
      },
      stdin: {
        type: 'string',
        description: 'Optional text to write to stdin before closing it.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'Optional timeout in milliseconds. Defaults to 60000 and is capped by the server.',
      },
      env: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Optional environment string overrides for this command.',
      },
    },
    required: [ 'command' ],
    additionalProperties: false,
  };
  static help = 'Use exec to run local commands through the Kikx server process login shell. The command sees the server environment plus normal login-shell startup files. stdout and stderr are stored in AeorDB with every tool result; large outputs are returned as tool output pointers readable with tool-output-get.';

  async _execute(params = {}) {
    return await resolveCommandExecutor(this.context).exec(params);
  }
}

function resolveCommandExecutor(context = {}) {
  let service = context.commandExecutor || context.services?.commandExecutor || resolveContextService(context, 'commandExecutor');
  if (!service?.exec)
    throw new Error('exec requires a commandExecutor service');

  return service;
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
