'use strict';

import { AeorDBAgentStore } from '../aeordb/aeordb-agent-store.mjs';

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

  async createAgent(input = {}) {
    let normalized = this.normalizeInput(input, { creating: true });
    return await this.agentStore.createAgent(normalized);
  }

  async listAgents(options = {}) {
    return await this.agentStore.listAgents(options);
  }

  async getAgent(agentID) {
    return await this.agentStore.getAgent(agentID);
  }

  async updateAgent(agentID, input = {}) {
    let current = await this.agentStore.getAgent(agentID);
    let pluginID = input.pluginID ?? current.pluginID;
    let normalized = this.normalizeInput({ ...input, pluginID }, { creating: false });
    return await this.agentStore.updateAgent(agentID, normalized);
  }

  async deleteAgent(agentID) {
    await this.agentStore.deleteAgent(agentID);
  }

  normalizeInput(input, options = {}) {
    let provider = this.pluginRegistry.getAgentProvider(input.pluginID);
    if (!provider) {
      let error = new Error(`Unknown agent provider: ${input.pluginID || ''}`);
      error.status = 400;
      throw error;
    }

    let descriptor = provider.getAgentProviderDescriptor();
    let fields = descriptor.configFields || [];
    let configFields = new Set(fields.filter((field) => !field.secret).map((field) => field.name));
    let secretFields = new Set(fields.filter((field) => field.secret).map((field) => field.name));
    let config = input.config == null
      ? (options.creating ? {} : undefined)
      : normalizeObject(input.config, 'config');
    let secrets = input.secrets == null
      ? {}
      : normalizeObject(input.secrets, 'secrets');

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

    return {
      name: input.name,
      pluginID: input.pluginID,
      config,
      secrets,
      clearSecrets: input.clearSecrets,
      enabled: input.enabled,
    };
  }
}

function normalizeObject(value, fieldName) {
  if (value == null)
    return {};

  if (typeof value !== 'object' || Array.isArray(value))
    throw badRequest(`${fieldName} must be an object`);

  return { ...value };
}

function badRequest(message) {
  let error = new Error(message);
  error.status = 400;
  return error;
}
