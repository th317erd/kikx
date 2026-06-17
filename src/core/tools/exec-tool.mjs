'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

export class ExecTool extends PluginInterface {
  static pluginID = 'internal:command';
  static featureName = 'exec';
  static displayName = 'Execute command';
  static description = 'Execute a local shell command through the Kikx server process login shell.';
  static frameType = 'ShellToolFrame';
  static clientComponent = builtInToolComponent('kikx-shell-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command to execute in the Kikx server process login shell. Prefer foreground commands for long-running managed work; exec is already async and can keep the process managed.',
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
        description: 'Optional timeout in milliseconds for the async process. By default async exec has no timeout.',
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
  static help = [
    'Use exec to run local commands through the Kikx server process login shell.',
    'Exec is always async: Kikx starts a managed process, waits briefly for very short commands, and either returns the completed output immediately or returns an async process ID.',
    'For servers and other long-running work, prefer running the foreground command directly, then use exec-read or exec-status to inspect it while it remains managed.',
    'If a command truly needs shell detaching such as trailing &, nohup, disown, or setsid, Kikx will complete the shell wrapper when it exits; detached child processes may no longer be manageable with exec-status or exec-kill.',
    'When a process is still running, Kikx automatically wakes you with the stored completion result when it exits.',
    'Use exec-status, exec-read, exec-grep, and exec-kill to manage async exec processes.',
    'The command sees the server environment plus normal login-shell startup files. Tool results and process completion results are stored in AeorDB; large outputs are returned as tool output pointers readable with output-read.',
  ].join(' ');

  async _execute(params = {}) {
    return await resolveProcessManager(this.context).start(params, this.context, {
      autoWake: true,
      returnCompletionIfReady: true,
    });
  }
}

function resolveProcessManager(context = {}) {
  let service = context.processManager || context.services?.processManager || resolveContextService(context, 'processManager');
  if (!service?.start)
    throw new Error('exec requires a processManager service');

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
