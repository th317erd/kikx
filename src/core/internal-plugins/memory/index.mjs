'use strict';

import { Agent } from '../../models/agent-model.mjs';

// =============================================================================
// Memory Plugin
// =============================================================================
// Provides tools for reading/writing agent config and session context.
// Protected keys (apiKey, encryptedAPIKey) are stripped from all tool
// responses and inputs to prevent agents from accessing or overwriting
// sensitive credential data.
//
// Tools registered:
//   memory:getAgentConfig
//   memory:setAgentConfig
//   memory:updateAgentConfig
//   memory:getSessionContext
//   memory:setSessionContext
//   memory:updateSessionContext
// =============================================================================

function stripProtectedKeys(obj) {
  if (!obj || typeof obj !== 'object')
    return obj;

  let result = { ...obj };
  for (let key of Agent.PROTECTED_KEYS)
    delete result[key];

  return result;
}

export function setup({ registerTool, PluginInterface }) {

  // ---------------------------------------------------------------------------
  // memory:getAgentConfig
  // ---------------------------------------------------------------------------

  class GetAgentConfigTool extends PluginInterface {
    static pluginID    = 'memory';
    static featureName = 'getAgentConfig';
    static displayName = 'Get Agent Config';
    static description = 'Read the calling agent\'s configuration';
    static riskLevel   = 'low';
    static inputSchema = {
      type:       'object',
      properties: {},
    };

    async _execute(params) {
      let models  = this._context.getProperty('models');
      let { Agent: AgentModel } = models;
      let agentID = params.agentID;

      if (!agentID)
        throw new Error('agentID is required');

      let agent = await AgentModel.where.id.EQ(agentID).first();
      if (!agent)
        throw new Error(`Agent not found: ${agentID}`);

      return { config: agent.getSafeConfig() };
    }
  }

  // ---------------------------------------------------------------------------
  // memory:setAgentConfig
  // ---------------------------------------------------------------------------

  class SetAgentConfigTool extends PluginInterface {
    static pluginID    = 'memory';
    static featureName = 'setAgentConfig';
    static displayName = 'Set Agent Config';
    static description = 'Replace the calling agent\'s configuration';
    static riskLevel   = 'low';
    static inputSchema = {
      type:       'object',
      required:   ['config'],
      properties: {
        config: { type: 'object', description: 'The new configuration object' },
      },
    };

    async _execute(params) {
      let models  = this._context.getProperty('models');
      let { Agent: AgentModel } = models;
      let agentID = params.agentID;

      if (!agentID)
        throw new Error('agentID is required');

      let agent = await AgentModel.where.id.EQ(agentID).first();
      if (!agent)
        throw new Error(`Agent not found: ${agentID}`);

      let safeConfig = stripProtectedKeys(params.config);
      agent.setConfig(safeConfig);
      await agent.save();

      return { config: agent.getSafeConfig() };
    }
  }

  // ---------------------------------------------------------------------------
  // memory:updateAgentConfig
  // ---------------------------------------------------------------------------

  class UpdateAgentConfigTool extends PluginInterface {
    static pluginID    = 'memory';
    static featureName = 'updateAgentConfig';
    static displayName = 'Update Agent Config';
    static description = 'Merge partial updates into the calling agent\'s configuration';
    static riskLevel   = 'low';
    static inputSchema = {
      type:       'object',
      required:   ['updates'],
      properties: {
        updates: { type: 'object', description: 'Partial config to merge' },
      },
    };

    async _execute(params) {
      let models  = this._context.getProperty('models');
      let { Agent: AgentModel } = models;
      let agentID = params.agentID;

      if (!agentID)
        throw new Error('agentID is required');

      let agent = await AgentModel.where.id.EQ(agentID).first();
      if (!agent)
        throw new Error(`Agent not found: ${agentID}`);

      let safeUpdates = stripProtectedKeys(params.updates);
      agent.updateConfig(safeUpdates);
      await agent.save();

      return { config: agent.getSafeConfig() };
    }
  }

  // ---------------------------------------------------------------------------
  // memory:getSessionContext
  // ---------------------------------------------------------------------------

  class GetSessionContextTool extends PluginInterface {
    static pluginID    = 'memory';
    static featureName = 'getSessionContext';
    static displayName = 'Get Session Context';
    static description = 'Read a session\'s context metadata';
    static riskLevel   = 'low';
    static inputSchema = {
      type:       'object',
      properties: {
        sessionID: { type: 'string', description: 'Session ID (defaults to current session)' },
        effective: { type: 'boolean', default: false, description: 'If true, returns inherited context from parent chain' },
      },
    };

    async _execute(params) {
      let models     = this._context.getProperty('models');
      let { Session } = models;
      let sessionID  = params.sessionID || params.currentSessionID;

      if (!sessionID)
        throw new Error('sessionID is required');

      let session = await Session.where.id.EQ(sessionID).first();
      if (!session)
        throw new Error(`Session not found: ${sessionID}`);

      let context = (params.effective)
        ? await session.getEffectiveContext()
        : session.getContext();

      return { context };
    }
  }

  // ---------------------------------------------------------------------------
  // memory:setSessionContext
  // ---------------------------------------------------------------------------

  class SetSessionContextTool extends PluginInterface {
    static pluginID    = 'memory';
    static featureName = 'setSessionContext';
    static displayName = 'Set Session Context';
    static description = 'Replace a session\'s context metadata';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['context'],
      properties: {
        sessionID: { type: 'string', description: 'Session ID (defaults to current session)' },
        context:   { type: 'object', description: 'The new context object' },
      },
    };

    async _execute(params) {
      let models     = this._context.getProperty('models');
      let { Session } = models;
      let sessionID  = params.sessionID || params.currentSessionID;

      if (!sessionID)
        throw new Error('sessionID is required');

      let session = await Session.where.id.EQ(sessionID).first();
      if (!session)
        throw new Error(`Session not found: ${sessionID}`);

      session.setContext(params.context);
      await session.save();

      return { context: session.getContext() };
    }
  }

  // ---------------------------------------------------------------------------
  // memory:updateSessionContext
  // ---------------------------------------------------------------------------

  class UpdateSessionContextTool extends PluginInterface {
    static pluginID    = 'memory';
    static featureName = 'updateSessionContext';
    static displayName = 'Update Session Context';
    static description = 'Merge partial updates into a session\'s context';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['updates'],
      properties: {
        sessionID: { type: 'string', description: 'Session ID (defaults to current session)' },
        updates:   { type: 'object', description: 'Partial context to merge' },
      },
    };

    async _execute(params) {
      let models     = this._context.getProperty('models');
      let { Session } = models;
      let sessionID  = params.sessionID || params.currentSessionID;

      if (!sessionID)
        throw new Error('sessionID is required');

      let session = await Session.where.id.EQ(sessionID).first();
      if (!session)
        throw new Error(`Session not found: ${sessionID}`);

      session.updateContext(params.updates);
      await session.save();

      return { context: session.getContext() };
    }
  }

  // ---------------------------------------------------------------------------
  // Register all tools
  // ---------------------------------------------------------------------------

  registerTool('memory:getAgentConfig',      GetAgentConfigTool);
  registerTool('memory:setAgentConfig',      SetAgentConfigTool);
  registerTool('memory:updateAgentConfig',   UpdateAgentConfigTool);
  registerTool('memory:getSessionContext',   GetSessionContextTool);
  registerTool('memory:setSessionContext',   SetSessionContextTool);
  registerTool('memory:updateSessionContext', UpdateSessionContextTool);

  return () => {};
}
