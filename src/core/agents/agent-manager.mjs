'use strict';

import { AeorDBAgentStore } from '../aeordb/aeordb-agent-store.mjs';
import {
  CHARACTER_COMPRESSED_FIELD,
  MAX_CHARACTER_COMPRESSED_LENGTH,
} from './character-limits.mjs';

export class AgentManager {
  constructor(options = {}) {
    let { agentStore, aeordb, pluginRegistry } = options;

    if (!pluginRegistry)
      throw new TypeError('AgentManager requires pluginRegistry');

    this.pluginRegistry = pluginRegistry;
    this.agentStore = agentStore || new AeorDBAgentStore({ aeordb });
  }

  listProviders() {
    return this.pluginRegistry.listAgentProviderDescriptors();
  }

  // Aggregate the model catalog across every registered agent provider, tagged
  // with its pluginID. A provider that throws is skipped (never fails the list).
  listModels() {
    let models = [];
    for (let [ pluginID, AgentClass ] of this.pluginRegistry.getAgentProviders()) {
      if (typeof AgentClass?.getModels !== 'function')
        continue;

      try {
        let providerModels = AgentClass.getModels();
        for (let model of Array.isArray(providerModels) ? providerModels : [])
          models.push({ pluginID, ...model });
      } catch (_error) {
        // Skip a misbehaving provider's models.
      }
    }

    return models;
  }

  async createAgent(input = {}) {
    let normalized = await this.normalizeInput(input, { creating: true });
    return await this.agentStore.createAgent(normalized);
  }

  async listAgents(options = {}) {
    return await this.agentStore.listAgents(options);
  }

  async getAgent(agentID, options = {}) {
    return await this.agentStore.getAgent(agentID, options);
  }

  async resolveAgent(reference) {
    if (typeof reference !== 'string' || reference.trim() === '')
      throw badRequest('agent reference must be a non-empty string');

    let ref = reference.trim();

    if (typeof this.agentStore.findAgentByIDOrName === 'function') {
      let agent = await this.agentStore.findAgentByIDOrName(ref);
      if (agent)
        return agent;
    } else {
      try {
        let agent = await this.agentStore.getAgent(ref);
        if (agent?.id)
          return agent;
      } catch (error) {
        if (error.status !== 404)
          throw error;
      }

      let agents = await this.agentStore.listAgents({ limit: 500 });
      let lowered = ref.toLowerCase();
      let matches = agents.filter((agent) => agent.name?.toLowerCase() === lowered);
      if (matches.length === 1)
        return matches[0];

      if (matches.length > 1)
        throw badRequest(`Ambiguous agent name: ${ref}`);
    }

    let error = new Error(`Agent not found: ${ref}`);
    error.status = 404;
    throw error;
  }

  async updateAgent(agentID, input = {}) {
    let current = await this.agentStore.getAgent(agentID);
    let pluginID = input.pluginID ?? current.pluginID;
    let normalized = await this.normalizeInput({ ...input, pluginID }, { creating: false });
    return await this.agentStore.updateAgent(agentID, normalized);
  }

  async updateAgentCharacter(agentID, character, characterCompressed) {
    let patch = {
      character: normalizeRequiredString(character, 'character'),
    };

    if (characterCompressed !== undefined) {
      patch[CHARACTER_COMPRESSED_FIELD] = normalizeCompressedCharacter(
        characterCompressed,
        CHARACTER_COMPRESSED_FIELD,
      );
    }

    return await this.updateAgent(agentID, patch);
  }

  async setAgentCrowned(agentID, crowned = true) {
    return await this.agentStore.setAgentCrowned(agentID, crowned === true);
  }

  // Crowned master agents, best (master #1) first.
  async listMasterAgents(options = {}) {
    return await this.agentStore.listMasterAgents(options);
  }

  // Resolve the default agent for a session: the first enabled master agent, in
  // master order (#1, then #2, ...). Agents listed in `excludeAgentIDs` (for
  // example ones that just errored) are skipped, so callers get master #2 as the
  // first backup, #3 as the second, and so on. Returns null when none qualify.
  async resolveDefaultAgent(options = {}) {
    let exclude = new Set(normalizeStringArray(options.excludeAgentIDs));
    let masters = await this.listMasterAgents({ limit: options.limit || 500 });
    for (let agent of masters) {
      if (agent.enabled === false || exclude.has(agent.id))
        continue;

      return agent;
    }

    return null;
  }

  async deleteAgent(agentID) {
    await this.agentStore.deleteAgent(agentID);
  }

  async normalizeInput(input, options = {}) {
    let provider = this.pluginRegistry.getAgentProvider(input.pluginID);
    if (!provider) {
      let error = new Error(`Unknown agent provider: ${input.pluginID || ''}`);
      error.status = 400;
      throw error;
    }

    let descriptor;
    try {
      descriptor = await provider.getAgentProviderDescriptor();
    } catch (error) {
      throw badRequest(`Unable to resolve provider configuration for ${input.pluginID}: ${error?.message || error}`);
    }

    let fields = descriptor.configFields || [];
    let configFields = new Set(fields.filter((field) => !field.secret).map((field) => field.name));
    let secretFields = new Set(fields.filter((field) => field.secret).map((field) => field.name));
    let config = input.config == null
      ? (options.creating ? {} : undefined)
      : normalizeObject(input.config, 'config');
    let secrets = input.secrets == null
      ? {}
      : normalizeObject(input.secrets, 'secrets');
    let hasCharacter = Object.hasOwn(input, 'character');
    let character = hasCharacter
      ? normalizeOptionalString(input.character, 'character')
      : (options.creating ? '' : undefined);
    let hasCompressed = Object.hasOwn(input, CHARACTER_COMPRESSED_FIELD);
    let characterCompressed = hasCompressed
      ? normalizeCompressedCharacter(input[CHARACTER_COMPRESSED_FIELD], CHARACTER_COMPRESSED_FIELD)
      : (options.creating ? '' : undefined);

    for (let key of Object.keys(config || {})) {
      if (!configFields.has(key))
        throw badRequest(`Unknown config field for ${input.pluginID}: ${key}`);
    }

    for (let key of Object.keys(secrets)) {
      if (!secretFields.has(key))
        throw badRequest(`Unknown secret field for ${input.pluginID}: ${key}`);
    }

    if (Array.isArray(input.clearSecrets)) {
      for (let key of input.clearSecrets) {
        if (!secretFields.has(key))
          throw badRequest(`Unknown secret field for ${input.pluginID}: ${key}`);
      }
    }

    for (let field of fields) {
      if (!field.required || !options.creating)
        continue;

      let source = field.secret ? secrets : config;
      if (source[field.name] == null || source[field.name] === '')
        throw badRequest(`${field.name} is required`);
    }

    // Provider-specific validation (async hook). Generic `required` flags here
    // are static; a provider may need conditional rules (for example, an API key
    // required only when a default endpoint is used).
    if (options.creating && typeof provider.validateCreateAgent === 'function') {
      try {
        await provider.validateCreateAgent({ config, secrets, pluginID: input.pluginID });
      } catch (error) {
        throw badRequest(error?.message || String(error));
      }
    }

    return withoutUndefined({
      name: input.name,
      pluginID: input.pluginID,
      character,
      [CHARACTER_COMPRESSED_FIELD]: characterCompressed,
      config,
      secrets,
      clearSecrets: input.clearSecrets,
      enabled: input.enabled,
    });
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value))
    return [];

  let output = [];
  for (let item of value) {
    if (typeof item === 'string' && item.trim() !== '')
      output.push(item.trim());
  }

  return output;
}

function normalizeObject(value, fieldName) {
  if (value == null)
    return {};

  if (typeof value !== 'object' || Array.isArray(value))
    throw badRequest(`${fieldName} must be an object`);

  return { ...value };
}

function normalizeOptionalString(value, fieldName) {
  if (value == null)
    return '';

  if (typeof value !== 'string')
    throw badRequest(`${fieldName} must be a string`);

  return value.trim();
}

function normalizeRequiredString(value, fieldName) {
  let normalized = normalizeOptionalString(value, fieldName);
  if (normalized === '')
    throw badRequest(`${fieldName} must be a non-empty string`);

  return normalized;
}

// The compressed character is required by the self-service tool but optional at
// this storage boundary, so pre-P6 records without one keep loading. When a
// non-empty value is supplied it must be within the limit (D2).
function normalizeCompressedCharacter(value, fieldName) {
  let normalized = normalizeOptionalString(value, fieldName);
  if (normalized === '')
    return '';

  if (normalized.length > MAX_CHARACTER_COMPRESSED_LENGTH)
    throw badRequest(`${fieldName} must be ${MAX_CHARACTER_COMPRESSED_LENGTH} characters or fewer`);

  return normalized;
}

function withoutUndefined(value) {
  let normalized = {};

  for (let [key, item] of Object.entries(value)) {
    if (item !== undefined)
      normalized[key] = item;
  }

  return normalized;
}

function badRequest(message) {
  let error = new Error(message);
  error.status = 400;
  return error;
}
