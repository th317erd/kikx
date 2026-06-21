'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

class CwdTool extends PluginInterface {
  static pluginID = 'internal:cwd';
  static clientComponent = builtInToolComponent('kikx-cwd-tool-use');
  static riskLevel = 'none';

  cwdStore() {
    let store = this.context.agentCwdStore || this.context.services?.agentCwdStore || resolveContextService(this.context, 'agentCwdStore');
    if (!store)
      throw new Error(`${this.constructor.featureName} requires agentCwdStore`);

    return store;
  }

  agentID(params = {}) {
    let agentID = normalizeOptionalString(this.context.agent?.id || params._agentID);
    if (!agentID)
      throw new Error(`${this.constructor.featureName} requires an agent context`);

    return agentID;
  }

  sessionID(params = {}) {
    let sessionID = normalizeOptionalString(params._sessionID || this.context.session?.id || this.context.frame?.sessionID);
    if (!sessionID)
      throw new Error(`${this.constructor.featureName} requires a session context`);

    return sessionID;
  }
}

export class CwdGetTool extends CwdTool {
  static featureName = 'cwd-get';
  static displayName = 'Get shell cwd';
  static description = 'Read this agent session default working directory for shell exec.';
  static frameType = 'CwdGetToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  static help = 'Use cwd-get to inspect the current session-specific shell working directory that exec will use by default.';

  async _execute(params = {}) {
    return await this.cwdStore().getCWD(this.agentID(params), this.sessionID(params));
  }
}

export class CwdSetTool extends CwdTool {
  static featureName = 'cwd-set';
  static displayName = 'Set shell cwd';
  static description = 'Set this agent session default working directory for shell exec.';
  static frameType = 'CwdSetToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Directory to use as the default cwd for future exec calls in this session. Relative paths resolve from the current cwd.',
      },
    },
    required: [ 'cwd' ],
    additionalProperties: false,
  };
  static help = 'Use cwd-set to change the default working directory for future exec calls in this session. This behaves like cd: relative paths resolve from the current session cwd. The directory must exist.';

  async _execute(params = {}) {
    return await this.cwdStore().setCWD(this.agentID(params), this.sessionID(params), params.cwd || params.path || params.directory);
  }
}

export class CwdClearTool extends CwdTool {
  static featureName = 'cwd-clear';
  static displayName = 'Clear shell cwd';
  static description = 'Clear this agent session default working directory and return exec to the server base cwd.';
  static frameType = 'CwdClearToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  static help = 'Use cwd-clear to remove your session-specific exec cwd and return to the Kikx server base cwd.';

  async _execute(params = {}) {
    return await this.cwdStore().clearCWD(this.agentID(params), this.sessionID(params));
  }
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

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
