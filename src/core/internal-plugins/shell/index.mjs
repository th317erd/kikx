'use strict';

import { execFile }            from 'node:child_process';
import { parseShellCommands }  from './command-parser.mjs';
import { ShellPermissions }    from './shell-permissions.mjs';

// =============================================================================
// Shell Plugin
// =============================================================================
// Provides shell command execution as a registered tool.
// Commands are parsed into individual commands for per-command permission
// checking. If ANY command in a pipeline is denied, nothing executes.
// =============================================================================

export function setup({ registerTool, PluginInterface }) {
  class ShellTool extends PluginInterface {
    static pluginId    = 'shell';
    static featureName = 'execute';
    static displayName = 'Shell';
    static description = 'Execute shell commands';

    async _execute({ command, workingDirectory }) {
      if (!command || typeof command !== 'string')
        throw new Error('command is required');

      let cwd = workingDirectory || process.cwd();

      return new Promise((resolve, reject) => {
        execFile('/bin/sh', ['-c', command], { cwd, timeout: 30000 }, (error, stdout, stderr) => {
          if (error && error.killed) {
            resolve({
              stdout:   stdout || '',
              stderr:   stderr || 'Command timed out',
              exitCode: error.code || 124,
            });

            return;
          }

          resolve({
            stdout:   stdout || '',
            stderr:   stderr || '',
            exitCode: error ? (error.code || 1) : 0,
          });
        });
      });
    }

    getPermissionsClass() {
      return ShellPermissions;
    }

    getHelp() {
      return {
        ...super.getHelp(),
        usage:   'shell:execute { command: "ls -la", workingDirectory: "/tmp" }',
        examples: [
          { command: 'ls -la',             description: 'List files in detail' },
          { command: 'cat /etc/hostname',  description: 'Read a file' },
          { command: 'echo hello && ls',   description: 'Chain commands' },
        ],
      };
    }
  }

  registerTool('shell:execute', ShellTool);

  return () => {};
}
