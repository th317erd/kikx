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
    static pluginID    = 'shell';
    static featureName = 'execute';
    static displayName = 'Shell';
    static description = 'Execute shell commands';
    static inputSchema = {
      type:       'object',
      properties: {
        command:          { type: 'string', description: 'The shell command to execute' },
        workingDirectory: { type: 'string', description: 'Working directory for the command (optional)' },
      },
      required: ['command'],
    };

    async _execute({ command, workingDirectory }) {
      if (!command || typeof command !== 'string')
        throw new Error('command is required');

      let cwd   = workingDirectory || process.cwd();
      let shell = process.env.SHELL || '/bin/bash';

      // Login shell (-l) sources the user's profile chain
      // (~/.bash_profile, ~/.profile, etc.) so PATH, nvm, pyenv,
      // aliases, and other environment customizations are available.
      let env = {
        ...process.env,
        HISTFILE:  '/dev/null',  // Never read or write shell history
        HISTSIZE:  '0',          // Belt-and-suspenders: zero history entries
      };

      return new Promise((resolve) => {
        execFile(shell, ['-l', '-c', command], { cwd, env, timeout: 30000 }, (error, stdout, stderr) => {
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
        inputSchema: ShellTool.inputSchema,
        usage:       'shell:execute { command: "ls -la", workingDirectory: "/tmp" }',
        examples:    [
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
