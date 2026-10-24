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
  static description = 'Run a temporary one-shot program from arbitrary files plus a start command, or from a Node script shorthand, with optional npm dependencies.';
  static frameType = 'ScriptToolFrame';
  static clientComponent = builtInToolComponent('kikx-script-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description: 'Shell command that invokes the program after files are written, for example python3 main.py, bash run.sh, or node index.mjs. Runs with the temporary workspace as cwd.',
      },
      files: {
        type: 'array',
        description: 'Files to create in the temporary run workspace. Paths must be relative and may not escape it. Any language or file type is allowed.',
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
      script: {
        type: 'string',
        description: 'Legacy convenience: Node.js source for the entry script. Use start plus files for other languages. It is written to entry (default: package.json main, or index.mjs) and invoked with the server Node binary.',
      },
      packageJson: {
        type: 'object',
        description: 'Optional package.json contents as a JSON object. Use files if you prefer to provide package.json as a file. Only needed for npm dependencies.',
      },
      entry: {
        type: 'string',
        description: 'Legacy Node shorthand only: relative entry path. Defaults to packageJson.main, then index.mjs.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Legacy Node shorthand only: arguments passed to the script as process.argv[2..].',
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
    additionalProperties: false,
  };
  static help = [
    'Use exec-script when a task needs a real program rather than a long chain of shell commands.',
    'Provide files[] containing any files to create, then start: a shell command that invokes them in the temporary workspace, for example python3 main.py, bash run.sh, or node index.mjs.',
    'Any local interpreter works. The files are written first; start runs with the temporary workspace as cwd, and the KIKX_SESSION_CWD environment variable points at the session workspace.',
    'For a quick Node program you may use the legacy script (plus optional entry/args) shorthand instead of files plus start.',
    'Package.json is optional. When it declares dependencies or an npm lockfile is present, exec-script runs npm install (or npm ci) before start. Use install:true to force it, or install:false to skip it.',
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
          startCommand: workspace.startCommand,
          installCommand: workspace.installCommand,
          keepTempDir,
        }),
        cwd: workspace.dir,
        env: {
          ...normalizeEnvironment(params.env),
          KIKX_SCRIPT_DIR: workspace.dir,
          KIKX_SCRIPT_START: workspace.startCommand,
          ...(workspace.entry ? { KIKX_SCRIPT_ENTRY: workspace.entry } : {}),
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
