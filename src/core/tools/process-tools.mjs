'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

export class ExecListTool extends PluginInterface {
  static pluginID = 'internal:exec';
  static featureName = 'list';
  static displayName = 'List exec tasks';
  static description = 'List async exec tasks owned by this agent.';
  static frameType = 'ExecListToolFrame';
  static clientComponent = builtInToolComponent('kikx-exec-list-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Optional process status filter such as running, completed, killed, timed-out, or failed.',
      },
      includeCompleted: {
        type: 'boolean',
        description: 'Set false to only show running processes.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
      },
      offset: {
        type: 'integer',
        minimum: 0,
      },
    },
    additionalProperties: false,
  };
  static help = 'Use exec-list to inspect async exec tasks that belong to you.';

  async _execute(params = {}) {
    return resolveProcessManager(this.context).list(params);
  }
}

export class ExecStatusTool extends PluginInterface {
  static pluginID = 'internal:exec';
  static featureName = 'status';
  static displayName = 'Exec status';
  static description = 'Inspect status, byte counts, and stored completion output for one async exec task.';
  static frameType = 'ExecStatusToolFrame';
  static clientComponent = builtInToolComponent('kikx-exec-status-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      processID: {
        type: 'string',
        description: 'Process ID returned by exec.',
      },
    },
    required: [ 'processID' ],
    additionalProperties: false,
  };
  static help = 'Use exec-status with a processID to poll whether async exec is still running and find the completion tool output ID.';

  async _execute(params = {}) {
    return resolveProcessManager(this.context).status(params);
  }
}

export class ExecReadTool extends PluginInterface {
  static pluginID = 'internal:exec';
  static featureName = 'read';
  static displayName = 'Read exec output';
  static description = 'Read buffered stdout, stderr, or combined output from an async exec task, optionally by byte range.';
  static frameType = 'ExecReadToolFrame';
  static clientComponent = builtInToolComponent('kikx-exec-read-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      processID: {
        type: 'string',
      },
      stream: {
        type: 'string',
        enum: [ 'combined', 'stdout', 'stderr' ],
        description: 'Output stream to read. Defaults to combined.',
      },
      start: {
        type: 'integer',
        minimum: 0,
        description: 'Inclusive byte offset.',
      },
      end: {
        type: 'integer',
        minimum: 0,
        description: 'Exclusive byte offset.',
      },
      maxBytes: {
        type: 'integer',
        minimum: 1,
      },
      full: {
        type: 'boolean',
        description: 'Set true to read all currently buffered output.',
      },
    },
    required: [ 'processID' ],
    additionalProperties: false,
  };
  static help = 'Use exec-read to inspect live or completed async exec output. Use start/end byte ranges for large output.';

  async _execute(params = {}) {
    return await resolveProcessManager(this.context).read(params);
  }
}

export class ExecGrepTool extends PluginInterface {
  static pluginID = 'internal:exec';
  static featureName = 'grep';
  static displayName = 'Search exec output';
  static description = 'Search live or completed async exec output with a JavaScript regular expression.';
  static frameType = 'ExecGrepToolFrame';
  static clientComponent = builtInToolComponent('kikx-exec-grep-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      processID: {
        type: 'string',
      },
      pattern: {
        type: 'string',
        description: 'Regular expression pattern.',
      },
      flags: {
        type: 'string',
        description: 'Optional JavaScript RegExp flags such as i or m.',
      },
      stream: {
        type: 'string',
        enum: [ 'combined', 'stdout', 'stderr' ],
      },
      maxMatches: {
        type: 'integer',
        minimum: 1,
      },
    },
    required: [ 'processID', 'pattern' ],
    additionalProperties: false,
  };
  static help = 'Use exec-grep to find matching lines in live async exec output without reading everything.';

  async _execute(params = {}) {
    return await resolveProcessManager(this.context).grep(params);
  }
}

export class ExecKillTool extends PluginInterface {
  static pluginID = 'internal:exec';
  static featureName = 'kill';
  static displayName = 'Kill exec task';
  static description = 'Send a signal to an async exec task owned by this agent.';
  static frameType = 'ExecKillToolFrame';
  static clientComponent = builtInToolComponent('kikx-exec-kill-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      processID: {
        type: 'string',
      },
      signal: {
        type: 'string',
        description: 'POSIX signal name. Defaults to SIGTERM.',
      },
    },
    required: [ 'processID' ],
    additionalProperties: false,
  };
  static help = 'Use exec-kill to stop an async exec process. Default signal is SIGTERM; use SIGKILL only if needed.';

  async _execute(params = {}) {
    return resolveProcessManager(this.context).kill(params);
  }
}

function resolveProcessManager(context = {}) {
  let service = context.processManager || context.services?.processManager || resolveContextService(context, 'processManager');
  if (!service)
    throw new Error('exec tools require a processManager service');

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
