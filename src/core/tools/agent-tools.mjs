'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';
import {
  CHARACTER_COMPRESSED_FIELD,
  MAX_CHARACTER_COMPRESSED_LENGTH,
} from '../agents/character-limits.mjs';

class AgentTool extends PluginInterface {
  static pluginID = 'internal:agents';
  static clientComponent = builtInToolComponent('kikx-agent-tool-use');
  static riskLevel = 'none';

  agentManager() {
    let agentManager = this.context.agentManager || this.context.services?.agentManager || resolveContextService(this.context, 'agentManager');
    if (!agentManager)
      throw new Error(`${this.constructor.featureName} requires agentManager`);

    return agentManager;
  }

  sourceSession() {
    return this.context.sourceSession || this.context.session || null;
  }

  assertFirstGenerationDelegation(action) {
    if (!this.context.agent?.id)
      return;

    let generation = sessionGeneration(this.sourceSession());
    if (generation <= 0)
      return;

    let error = new Error(`${action} is only available to first-generation agents. Current session generation is ${generation}.`);
    error.status = 403;
    throw error;
  }

  // Validate a provider/plugin ID against the registered agent providers, so a
  // typo fails fast with the list of valid IDs instead of a generic error.
  async assertKnownProvider(pluginID) {
    let agentManager = this.agentManager();
    if (typeof agentManager.listProviders !== 'function')
      return;

    let providers = await agentManager.listProviders();
    if (!Array.isArray(providers) || providers.length === 0)
      return;

    if (providers.some((provider) => provider?.pluginID === pluginID))
      return;

    let available = providers.map((provider) => provider.pluginID).filter(Boolean).sort();
    throw new Error(`Unknown agent provider: ${pluginID}. Available providers: ${available.join(', ') || 'none'}`);
  }
}

export class AgentCreateTool extends AgentTool {
  static featureName = 'agent-create';
  static displayName = 'Create agent';
  static description = 'Create a Kikx agent from a configured provider.';
  static frameType = 'AgentCreateToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Display name for the new agent. Used to resolve the agent by name later.',
      },
      pluginID: {
        type: 'string',
        description: 'Agent provider/plugin ID to build the agent from (see agent-list or GET /api/v1/agent-providers).',
      },
      character: {
        type: 'string',
        description: 'Optional durable persona/character prompt for the agent.',
      },
      compressedCharacter: {
        type: 'string',
        maxLength: MAX_CHARACTER_COMPRESSED_LENGTH,
        description: `Optional compressed (short) form of the character, at most ${MAX_CHARACTER_COMPRESSED_LENGTH} characters, used in start briefs.`,
      },
      config: {
        type: 'object',
        description: 'Optional non-secret provider config (for example model, baseURL).',
      },
      secrets: {
        type: 'object',
        description: 'Optional secret provider credentials (for example apiKey). Never returned in results.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the agent is enabled. Defaults to true.',
      },
    },
    required: [ 'name', 'pluginID' ],
    additionalProperties: false,
  };
  static help = 'Use agent-create to add a new agent from a provider. Discover pluginID values from agent-list (existing agents) or GET /api/v1/agent-providers. Use agent-update to change an existing agent.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('agent-create');

    let name = normalizeRequiredString(params.name, 'name');
    let pluginID = normalizeRequiredString(params.pluginID, 'pluginID');
    await this.assertKnownProvider(pluginID);

    let agent = await this.agentManager().createAgent({
      name,
      pluginID,
      character: params.character === undefined ? '' : normalizeOptionalString(params.character),
      [CHARACTER_COMPRESSED_FIELD]: params.compressedCharacter === undefined
        ? ''
        : normalizeCompressedCharacter(params.compressedCharacter),
      config: normalizeOptionalObject(params.config, 'config'),
      secrets: normalizeOptionalObject(params.secrets, 'secrets'),
      enabled: params.enabled === undefined ? true : params.enabled === true,
    });

    return {
      agent: sanitizeAgent(agent),
      created: true,
    };
  }
}

export class AgentUpdateTool extends AgentTool {
  static featureName = 'agent-update';
  static displayName = 'Update agent';
  static description = 'Edit an existing Kikx agent (name, character, provider, config, secrets, or enabled state).';
  static frameType = 'AgentUpdateToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Agent ID or exact agent name to edit.',
      },
      name: {
        type: 'string',
        description: 'New display name.',
      },
      character: {
        type: 'string',
        description: 'New persona/character prompt. An empty string clears it.',
      },
      compressedCharacter: {
        type: 'string',
        maxLength: MAX_CHARACTER_COMPRESSED_LENGTH,
        description: `New compressed (short) character used in start briefs, at most ${MAX_CHARACTER_COMPRESSED_LENGTH} characters. An empty string clears it.`,
      },
      pluginID: {
        type: 'string',
        description: 'New agent provider/plugin ID (rarely changed).',
      },
      config: {
        type: 'object',
        description: 'Replacement non-secret config object. Omit to keep the existing config.',
      },
      secrets: {
        type: 'object',
        description: 'Secret keys to set or update. Omit to keep existing secrets.',
      },
      clearSecrets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Secret keys to remove.',
      },
      enabled: {
        type: 'boolean',
        description: 'Enable or disable the agent.',
      },
    },
    required: [ 'agent' ],
    additionalProperties: false,
  };
  static help = 'Use agent-update to edit an existing agent. Provide `agent` as an ID or exact name plus only the fields to change; omitted fields are left unchanged.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('agent-update');

    let agentManager = this.agentManager();
    let reference = normalizeRequiredString(params.agent, 'agent');
    let existing = await agentManager.resolveAgent(reference);
    if (!existing?.id)
      throw new Error(`Agent not found: ${reference}`);

    let patch = {};
    if (params.name !== undefined)
      patch.name = normalizeRequiredString(params.name, 'name');

    if (params.character !== undefined)
      patch.character = normalizeOptionalString(params.character);

    if (params.compressedCharacter !== undefined)
      patch[CHARACTER_COMPRESSED_FIELD] = normalizeCompressedCharacter(params.compressedCharacter);

    if (params.pluginID !== undefined) {
      let pluginID = normalizeRequiredString(params.pluginID, 'pluginID');
      await this.assertKnownProvider(pluginID);
      patch.pluginID = pluginID;
    }

    if (params.config !== undefined)
      patch.config = normalizeOptionalObject(params.config, 'config');

    if (params.secrets !== undefined)
      patch.secrets = normalizeOptionalObject(params.secrets, 'secrets');

    if (params.clearSecrets !== undefined)
      patch.clearSecrets = normalizeStringArray(params.clearSecrets);

    if (params.enabled !== undefined)
      patch.enabled = params.enabled === true;

    if (Object.keys(patch).length === 0)
      throw new Error('agent-update requires at least one field to change');

    let agent = await agentManager.updateAgent(existing.id, patch);
    return {
      agent: sanitizeAgent(agent),
      updated: true,
    };
  }
}

function sanitizeAgent(agent = {}) {
  return {
    id: agent.id || null,
    name: agent.name || agent.id || '',
    pluginID: agent.pluginID || null,
    character: typeof agent.character === 'string' ? agent.character : '',
    [CHARACTER_COMPRESSED_FIELD]: typeof agent[CHARACTER_COMPRESSED_FIELD] === 'string' ? agent[CHARACTER_COMPRESSED_FIELD] : '',
    config: isPlainObject(agent.config) ? { ...agent.config } : {},
    secretState: agent.secretState || null,
    enabled: agent.enabled !== false,
    crownedAt: agent.crownedAt || null,
    crownedClock: agent.crownedClock || null,
    createdAt: agent.createdAt || null,
    updatedAt: agent.updatedAt || null,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalObject(value, fieldName) {
  if (value == null)
    return {};

  if (!isPlainObject(value))
    throw new TypeError(`${fieldName} must be an object`);

  return { ...value };
}

function normalizeStringArray(values) {
  if (!Array.isArray(values))
    return [];

  let output = [];
  for (let value of values) {
    let normalized = normalizeOptionalString(value);
    if (normalized && !output.includes(normalized))
      output.push(normalized);
  }

  return output;
}

function normalizeRequiredString(value, fieldName) {
  let normalized = normalizeOptionalString(value);
  if (!normalized)
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Optional at the tool boundary (create/edit may legitimately omit it), but
// bounded when supplied (D2).
function normalizeCompressedCharacter(value) {
  let normalized = normalizeOptionalString(value);
  if (normalized.length > MAX_CHARACTER_COMPRESSED_LENGTH)
    throw new TypeError(`${CHARACTER_COMPRESSED_FIELD} must be ${MAX_CHARACTER_COMPRESSED_LENGTH} characters or fewer`);

  return normalized;
}

function sessionGeneration(session) {
  if (!session || typeof session !== 'object')
    return 0;

  let number = Number(session.generation);
  if (Number.isFinite(number) && number >= 0)
    return Math.trunc(number);

  return session.parentSessionID ? 1 : 0;
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
