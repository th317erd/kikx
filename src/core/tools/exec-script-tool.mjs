'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { resolveFileToolParams } from './file-tool-cwd.mjs';
import {
  buildScriptShellCommand,
  prepareScriptWorkspace,
  removeScriptWorkspace,
} from './script-workspace.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

export class ExecScriptTool extends PluginInterface {
  static pluginID = 'internal:command';
  static featureName = 'exec-script';
  static displayName = 'Execute script';
  static description = 'Run a temporary Node.js script with its own package.json, optional supporting files, and installed dependencies.';
  static frameType = 'ScriptToolFrame';
  static clientComponent = builtInToolComponent('kikx-script-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'JavaScript source for the entry script. It is written to entry (default: package.json main, or index.mjs).',
      },
      packageJson: {
        type: 'object',
        description: 'package.json contents as a JSON object. Use files if you prefer to provide package.json as a file. Defaults to a private ESM package.',
      },
      files: {
        type: 'array',
        description: 'Optional supporting files to write beside the entry script. Paths must be relative and may not escape the temporary workspace.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path such as src/helper.mjs or data.json.',
            },
            content: {
              type: 'string',
              description: 'File content. For base64 encoding, this must be a base64 string.',
            },
            encoding: {
              type: 'string',
              enum: [ 'utf8', 'base64' ],
              description: 'Encoding of content. Defaults to utf8.',
            },
          },
          required: [ 'path', 'content' ],
          additionalProperties: false,
        },
      },
      entry: {
        type: 'string',
        description: 'Optional relative entry path. Defaults to packageJson.main, then index.mjs.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional arguments passed to the script as process.argv[2..].',
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optional environment string overrides for the install and script process.',
      },
      stdin: {
        type: 'string',
        description: 'Optional text to write to the script process stdin before closing it.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'Optional timeout in milliseconds for the managed install-and-run process. By default it has no timeout.',
      },
      install: {
        type: 'boolean',
        description: 'Force dependency installation on or off. By default npm install runs only when package.json declares dependencies or includes an npm lockfile.',
      },
      keepTempDir: {
        type: 'boolean',
        description: 'Set true to keep the temporary script workspace after completion for debugging. The process result cwd is the workspace path. Defaults to false and deletes it on exit.',
      },
    },
    required: [ 'script' ],
    additionalProperties: false,
  };
  static help = [
    'Use exec-script when a task needs a real program rather than a long chain of shell commands:',
    'one JavaScript entry script, an optional package.json, optional supporting files, dependency installation, and a single exit code/stdout/stderr result.',
    'It writes everything to a fresh temporary directory, runs npm install when dependencies or an npm lockfile are present, then invokes the entry with the same Node binary as the Kikx server.',
    'The script runs with the temporary workspace as its cwd. The KIKX_SESSION_CWD environment variable points at the session workspace; use that or absolute paths when you need the workspace.',
    'Pass multiple files through files[]; the main source is script and is written to entry (packageJson.main by default).',
    'The process is managed exactly like exec: it can return immediately for fast scripts or an async process ID with automatic completion wake for longer installs/runs. Use exec-status, exec-read, exec-grep, and exec-kill to manage it.',
    'Set keepTempDir when you need to inspect the generated files after failure. Otherwise the temporary workspace is removed when the process exits.',
  ].join(' ');

  async _execute(params = {}) {
    let processManager = resolveProcessManager(this.context);
    let workspace = await prepareScriptWorkspace(params);
    let keepTempDir = workspace.keepTempDir;
    let sessionCwd = await resolveSessionCwd(this.context);

    try {
      return await processManager.start({
        command: buildScriptShellCommand({
          dir: workspace.dir,
          entry: workspace.entry,
          args: params.args,
          installCommand: workspace.installCommand,
          keepTempDir,
        }),
        cwd: workspace.dir,
        env: {
          ...normalizeEnvironment(params.env),
          KIKX_SCRIPT_DIR: workspace.dir,
          KIKX_SCRIPT_ENTRY: workspace.entry,
          ...(sessionCwd ? { KIKX_SESSION_CWD: sessionCwd } : {}),
        },
        stdin: params.stdin,
        timeoutMs: params.timeoutMs,
        _agentID: params._agentID,
        _sessionID: params._sessionID,
        _frameID: params._frameID,
      }, this.context, {
        autoWake: true,
        returnCompletionIfReady: true,
      });
    } catch (error) {
      if (!keepTempDir)
        await removeScriptWorkspace(workspace.dir);
      throw error;
    }
  }
}

async function resolveSessionCwd(context = {}) {
  try {
    let resolved = await resolveFileToolParams({}, context);
    return typeof resolved?.cwd === 'string' && resolved.cwd.trim() !== '' ? resolved.cwd : '';
  } catch (_error) {
    return '';
  }
}

function normalizeEnvironment(value) {
  if (value == null)
    return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('env must be an object when provided');

  let env = {};
  for (let [ key, item ] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new TypeError(`env key is invalid: ${key}`);
    if (typeof item !== 'string')
      throw new TypeError(`env.${key} must be a string`);
    env[key] = item;
  }
  return env;
}

function resolveProcessManager(context = {}) {
  let service = context.processManager || context.services?.processManager || resolveContextService(context, 'processManager');
  if (!service?.start)
    throw new Error('exec-script requires a processManager service');

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
