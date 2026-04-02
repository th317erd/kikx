'use strict';

import { Agent }                  from '../../models/agent-model.mjs';
import { decryptAgentPrivateKey } from '../../crypto/frame-signing.mjs';
import {
  computeKeyFingerprint,
  signValue,
  verifyValue,
} from '../../crypto/value-signing.mjs';
import { MemoryPermissions } from './memory-permissions.mjs';

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
//   memory:getValue
//   memory:setValue
//   memory:searchValues
// =============================================================================

/**
 * @param {Record<string, any> | null} obj
 * @returns {Record<string, any> | null}
 */
function stripProtectedKeys(obj) {
  if (!obj || typeof obj !== 'object')
    return obj;

  let result = { ...obj };
  for (let key of Agent.PROTECTED_KEYS)
    delete result[key];

  return result;
}

/**
 * @param {(cb: (ctx: { registry: any }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry }) => {
    let PluginInterface = registry.getClass('PluginInterface');

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

      getPermissionsClass() {
        return MemoryPermissions;
      }

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:getAgentConfig {}',
          examples: [
            { description: 'Read your current configuration' },
          ],
        };
      }

      /**
       * @param {{ agentID?: string }} params
       * @returns {Promise<{ config: Record<string, any> }>}
       */
      async _execute(params) {
        let models  = this._context.getProperty('models');
        let { Agent: AgentModel } = models;
        let agentID = params.agentID;

        if (!agentID)
          throw new Error('agentID is required');

        let agent = await AgentModel.where.id.EQ(agentID).first();
        if (!agent)
          throw new Error(`Agent not found: ${agentID}`);

        return { config: await agent.getSafeConfig() };
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

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:setAgentConfig { config: { ... } }',
          examples: [
            { config: { greeting: 'Hello!' }, description: 'Replace config with a new object' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ config: Record<string, any>, agentID?: string }} params
       * @returns {Promise<{ config: Record<string, any> }>}
       */
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
        await agent.setConfig(safeConfig);

        return { config: await agent.getSafeConfig() };
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

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:updateAgentConfig { updates: { ... } }',
          examples: [
            { updates: { greeting: 'Hi!' }, description: 'Merge partial updates into existing config' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ updates: Record<string, any>, agentID?: string }} params
       * @returns {Promise<{ config: Record<string, any> }>}
       */
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
        await agent.updateConfig(safeUpdates);

        return { config: await agent.getSafeConfig() };
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

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:getSessionContext { sessionID: "ses_..." }',
          examples: [
            { description: 'Read context for the current session' },
            { sessionID: 'ses_abc', description: 'Read context for a specific session' },
            { effective: true, description: 'Read inherited context from the parent chain' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ sessionID?: string, currentSessionID?: string, effective?: boolean }} params
       * @returns {Promise<{ context: Record<string, any> }>}
       */
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
          : await session.getContext();

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

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:setSessionContext { context: { ... } }',
          examples: [
            { context: { topic: 'planning' }, description: 'Replace session context' },
            { sessionID: 'ses_abc', context: { topic: 'review' }, description: 'Set context on a specific session' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ context: Record<string, any>, sessionID?: string, currentSessionID?: string }} params
       * @returns {Promise<{ context: Record<string, any> }>}
       */
      async _execute(params) {
        let models     = this._context.getProperty('models');
        let { Session } = models;
        let sessionID  = params.sessionID || params.currentSessionID;

        if (!sessionID)
          throw new Error('sessionID is required');

        let session = await Session.where.id.EQ(sessionID).first();
        if (!session)
          throw new Error(`Session not found: ${sessionID}`);

        await session.setContext(params.context);

        return { context: await session.getContext() };
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

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:updateSessionContext { updates: { ... } }',
          examples: [
            { updates: { topic: 'design' }, description: 'Merge updates into current session context' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ updates: Record<string, any>, sessionID?: string, currentSessionID?: string }} params
       * @returns {Promise<{ context: Record<string, any> }>}
       */
      async _execute(params) {
        let models     = this._context.getProperty('models');
        let { Session } = models;
        let sessionID  = params.sessionID || params.currentSessionID;

        if (!sessionID)
          throw new Error('sessionID is required');

        let session = await Session.where.id.EQ(sessionID).first();
        if (!session)
          throw new Error(`Session not found: ${sessionID}`);

        await session.updateContext(params.updates);

        return { context: await session.getContext() };
      }
    }

    // ---------------------------------------------------------------------------
    // memory:getValue
    // ---------------------------------------------------------------------------

    class GetMemoryValueTool extends PluginInterface {
      static pluginID    = 'memory';
      static featureName = 'getValue';
      static displayName = 'Get Memory Value';
      static description = 'Get a value from agent memory storage. Returns signed/verified flags if the value was stored with signing.';
      static riskLevel   = 'low';
      static inputSchema = {
        type:       'object',
        required:   ['key'],
        properties: {
          key: {
            type:        'string',
            description: 'The key to retrieve',
          },
          scopeID: {
            type:        'string',
            description: 'Optional scope ID (defaults to current session ID)',
          },
        },
      };

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:getValue { key: "my-key" }',
          examples: [
            { key: 'user-prefs', description: 'Retrieve a stored value by key' },
            { key: 'notes', scopeID: 'ses_abc', description: 'Retrieve a value scoped to a specific session' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ key: string, scopeID?: string, agentID?: string, currentSessionID?: string }} params
       * @returns {Promise<{ key: string, value: any, scopeID: string, signed?: boolean, verified?: boolean }>}
       */
      async _execute(params) {
        let { key, scopeID } = params;
        let models  = this._context.getProperty('models');
        let { Agent: AgentModel, ValueStore } = models;
        let agentID = params.agentID;

        if (!agentID)
          throw new Error('agentID is required');

        let agent = await AgentModel.where.id.EQ(agentID).first();
        if (!agent)
          throw new Error(`Agent not found: ${agentID}`);

        // Default scope to current session ID
        if (scopeID === undefined || scopeID === null)
          scopeID = params.currentSessionID || '';

        let entry = await ValueStore
          .where.ownerType.EQ('Agent')
          .ownerID.EQ(agent.id)
          .namespace.EQ('memory')
          .scopeID.EQ(scopeID)
          .key.EQ(key)
          .first();

        if (!entry)
          return { key, value: null, scopeID };

        let value = null;
        try {
          value = JSON.parse(entry.value);
        } catch (_e) {
          value = entry.value;
        }

        let result = { key, value, scopeID };

        // Include signing verification if the entry has a signature
        if (entry.signature) {
          result.signed = true;

          let keystore = this._context.getProperty('keystore');
          result.verified = verifyValue(
            keystore, agent.publicKey,
            'Agent', agent.id, 'memory', scopeID, key,
            entry.value, entry.signature,
          );
        } else {
          result.signed = false;
        }

        return result;
      }
    }

    // ---------------------------------------------------------------------------
    // memory:setValue
    // ---------------------------------------------------------------------------

    class SetMemoryValueTool extends PluginInterface {
      static pluginID    = 'memory';
      static featureName = 'setValue';
      static displayName = 'Set Memory Value';
      static description = 'Store a value in agent memory storage. Pass sign:true to cryptographically sign the value for tamper detection on retrieval.';
      static riskLevel   = 'low';
      static inputSchema = {
        type:       'object',
        required:   ['key', 'value'],
        properties: {
          key: {
            type:        'string',
            description: 'The key to store',
          },
          value: {
            description: 'The value to store (any JSON type)',
          },
          scopeID: {
            type:        'string',
            description: 'Optional scope ID (defaults to current session ID)',
          },
          sign: {
            type:        'boolean',
            description: 'If true, cryptographically sign the value with the agent\'s Ed25519 key for tamper detection',
          },
        },
      };

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:setValue { key: "my-key", value: "my-value" }',
          examples: [
            { key: 'user-prefs', value: { theme: 'dark' }, description: 'Store a JSON value' },
            { key: 'secret', value: 'data', sign: true, description: 'Store a cryptographically signed value' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ key: string, value: any, scopeID?: string, sign?: boolean, agentID?: string, currentSessionID?: string, _agent?: import('../../types').Agent }} params
       * @returns {Promise<{ key: string, value: any, scopeID: string, deleted?: boolean, signed?: boolean }>}
       */
      async _execute(params) {
        let { key, value, scopeID, sign } = params;
        let models  = this._context.getProperty('models');
        let { Agent: AgentModel, ValueStore } = models;
        let agentID = params.agentID;

        if (!agentID)
          throw new Error('agentID is required');

        let agent = await AgentModel.where.id.EQ(agentID).first();
        if (!agent)
          throw new Error(`Agent not found: ${agentID}`);

        // Default scope to current session ID
        if (scopeID === undefined || scopeID === null)
          scopeID = params.currentSessionID || '';

        if (value === null || value === undefined) {
          // Delete the entry
          let existing = await ValueStore
            .where.ownerType.EQ('Agent')
            .ownerID.EQ(agent.id)
            .namespace.EQ('memory')
            .scopeID.EQ(scopeID)
            .key.EQ(key)
            .first();

          if (existing)
            await existing.destroy();

          return { key, value: null, scopeID, deleted: true };
        }

        let jsonValue             = JSON.stringify(value);
        let signature             = null;
        let signingKeyFingerprint = null;

        // Sign the value if requested
        if (sign) {
          let keystore = this._context.getProperty('keystore');

          // Use _agent (injected by executeTool) or fall back to fetched agent
          let sourceAgent = params._agent || agent;

          if (!sourceAgent.encryptedPrivateKey)
            throw new Error('Agent does not have a signing key pair — cannot sign value');

          let privateKeyPEM = decryptAgentPrivateKey(keystore, sourceAgent.encryptedPrivateKey, agent.id);
          if (!privateKeyPEM)
            throw new Error('Failed to decrypt agent private key for signing');

          let signed = signValue(
            keystore, privateKeyPEM, agent.publicKey,
            'Agent', agent.id, 'memory', scopeID, key,
            jsonValue,
          );

          if (!signed)
            throw new Error('Failed to sign value');

          signature             = signed.signature;
          signingKeyFingerprint = signed.fingerprint;
        }

        // Upsert
        let existing = await ValueStore
          .where.ownerType.EQ('Agent')
          .ownerID.EQ(agent.id)
          .namespace.EQ('memory')
          .scopeID.EQ(scopeID)
          .key.EQ(key)
          .first();

        if (existing) {
          existing.value                 = jsonValue;
          existing.signature             = signature;
          existing.signingKeyFingerprint = signingKeyFingerprint;
          await existing.save();
        } else {
          await ValueStore.create({
            organizationID:       agent.organizationID,
            ownerType:            'Agent',
            ownerID:              agent.id,
            namespace:            'memory',
            scopeID,
            key,
            value:                jsonValue,
            signature,
            signingKeyFingerprint,
          });
        }

        let result = { key, value, scopeID };

        if (sign)
          result.signed = true;

        return result;
      }
    }

    // ---------------------------------------------------------------------------
    // memory:searchValues
    // ---------------------------------------------------------------------------

    class SearchMemoryValuesTool extends PluginInterface {
      static pluginID    = 'memory';
      static featureName = 'searchValues';
      static displayName = 'Search Memory Values';
      static description = 'Search agent memory storage by key or value content. Results include signed/verified flags for signed values.';
      static riskLevel   = 'low';
      static inputSchema = {
        type:       'object',
        properties: {
          query: {
            type:        'string',
            description: 'Search query (empty = list all)',
          },
          scopeID: {
            type:        'string',
            description: 'Optional scope ID (null = search all scopes)',
          },
          limit: {
            type:        'integer',
            description: 'Maximum results (default 20)',
          },
          offset: {
            type:        'integer',
            description: 'Skip first N results (default 0)',
          },
        },
      };

      getHelp() {
        return {
          ...super.getHelp(),
          usage:    'memory:searchValues { query: "search-term" }',
          examples: [
            { query: 'prefs', description: 'Search memory by key or value content' },
            { description: 'List all stored values' },
            { query: 'notes', limit: 5, description: 'Search with a result limit' },
          ],
        };
      }

      getPermissionsClass() {
        return MemoryPermissions;
      }

      /**
       * @param {{ query?: string, scopeID?: string, limit?: number, offset?: number, agentID?: string }} params
       * @returns {Promise<{ results: Array<{ key: string, value: any, scopeID: string, updatedAt: Date, signed: boolean, verified?: boolean }>, count: number }>}
       */
      async _execute(params) {
        let { query, scopeID, limit, offset } = params;
        let models  = this._context.getProperty('models');
        let { Agent: AgentModel, ValueStore } = models;
        let agentID = params.agentID;

        if (!agentID)
          throw new Error('agentID is required');

        let agent = await AgentModel.where.id.EQ(agentID).first();
        if (!agent)
          throw new Error(`Agent not found: ${agentID}`);

        limit  = limit || 20;
        offset = offset || 0;

        // Build base query
        let q = ValueStore
          .where.ownerType.EQ('Agent')
          .ownerID.EQ(agent.id)
          .namespace.EQ('memory');

        // Scope filtering: undefined/null = all scopes, '' = default scope only
        if (scopeID !== undefined && scopeID !== null)
          q = q.scopeID.EQ(scopeID);

        let entries = await q.all();

        // Filter by query if provided (in-JS LIKE matching)
        if (query) {
          let lowerQuery = query.toLowerCase();
          entries = entries.filter((entry) => {
            let keyMatch   = entry.key.toLowerCase().includes(lowerQuery);
            let valueMatch = entry.value && entry.value.toLowerCase().includes(lowerQuery);
            return keyMatch || valueMatch;
          });
        }

        let count = entries.length;

        // Apply offset and limit
        entries = entries.slice(offset, offset + limit);

        let keystore = this._context.getProperty('keystore');

        let results = entries.map((entry) => {
          let value = null;
          try {
            value = JSON.parse(entry.value);
          } catch (_e) {
            value = entry.value;
          }

          let result = {
            key:       entry.key,
            value,
            scopeID:   entry.scopeID,
            updatedAt: entry.updatedAt,
            signed:    !!entry.signature,
          };

          if (entry.signature) {
            result.verified = verifyValue(
              keystore, agent.publicKey,
              'Agent', agent.id, 'memory', entry.scopeID, entry.key,
              entry.value, entry.signature,
            );
          }

          return result;
        });

        return { results, count };
      }
    }

    // ---------------------------------------------------------------------------
    // Register all tools
    // ---------------------------------------------------------------------------

    registry.registerTool('memory:getAgentConfig',      GetAgentConfigTool);
    registry.registerTool('memory:setAgentConfig',      SetAgentConfigTool);
    registry.registerTool('memory:updateAgentConfig',   UpdateAgentConfigTool);
    registry.registerTool('memory:getSessionContext',   GetSessionContextTool);
    registry.registerTool('memory:setSessionContext',   SetSessionContextTool);
    registry.registerTool('memory:updateSessionContext', UpdateSessionContextTool);
    registry.registerTool('memory:getValue',            GetMemoryValueTool);
    registry.registerTool('memory:setValue',            SetMemoryValueTool);
    registry.registerTool('memory:searchValues',        SearchMemoryValuesTool);
  });

  return () => {};
}
