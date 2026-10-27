'use strict';

import { AeorDBAgentStore, MAX_COMPACTION_BOTS } from '../aeordb/aeordb-agent-store.mjs';
import {
  CHARACTER_COMPRESSED_FIELD,
  MAX_CHARACTER_COMPRESSED_LENGTH,
} from './character-limits.mjs';
import { normalizeTagInputList, tagNumber } from '../tags/tag-definitions.mjs';

export class AgentManager {
  constructor(options = {}) {
    let { agentStore, pluginRegistry, tagsStore = null } = options;
    let db = options.db || options.aeordb;

    if (!pluginRegistry)
      throw new TypeError('AgentManager requires pluginRegistry');

    this.pluginRegistry = pluginRegistry;
    this.tagsStore = tagsStore;
    this.agentStore = agentStore || new AeorDBAgentStore({ db });
  }

  listProviders() {
    return this.pluginRegistry.listAgentProviderDescriptors();
  }

  listTagDefinitions() {
    return typeof this.pluginRegistry.listTagDefinitions === 'function'
      ? this.pluginRegistry.listTagDefinitions()
      : [];
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
    let created = await this.agentStore.createAgent(normalized);
    if (Array.isArray(normalized.tags) && this.tagsStore?.applyTags)
      await this.tagsStore.applyTags('agent', created.id, normalized.tags);
    return await this.getAgent(created.id);
  }

  async listAgents(options = {}) {
    let agents = await this.agentStore.listAgents(options);
    return await this.attachTags(agents);
  }

  async getAgent(agentID, options = {}) {
    let agent = await this.agentStore.getAgent(agentID, options);
    let [enriched] = await this.attachTags([ agent ]);
    return enriched;
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
    await this.agentStore.updateAgent(agentID, normalized);
    if (Array.isArray(normalized.tags) && this.tagsStore?.applyTags)
      await this.tagsStore.applyTags('agent', agentID, normalized.tags);
    return await this.getAgent(agentID);
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
    let updated = await this.agentStore.setAgentCrowned(agentID, crowned === true);
    return typeof this.agentStore.getAgent === 'function' ? await this.getAgent(agentID) : updated;
  }

  // Crowned master agents, best (master #1) first.
  async listMasterAgents(options = {}) {
    return await this.attachTags(await this.agentStore.listMasterAgents(options));
  }

  async setAgentCompactionBotCrowned(agentID, crowned = true) {
    let updated = await this.agentStore.setAgentCompactionBotCrowned(agentID, crowned === true);
    // Refresh the synchronous snapshot so `selectCompactor` sees the change the
    // moment this await resolves.
    await this.refreshCompactionBots();
    return typeof this.agentStore.getAgent === 'function' ? await this.getAgent(agentID) : updated;
  }

  // Designated compaction bots, best (#1) first. This is a SYNCHRONOUS snapshot
  // of the last-known list: `selectCompactor` rung 2 reads it synchronously, so
  // the manager caches the store's async result and serves it from memory. The
  // cache is refreshed by `refreshCompactionBots()` — awaited by the compaction
  // service before selection — and after every compaction-bot toggle.
  listCompactionBots(options = {}) {
    let bots = Array.isArray(this._compactionBots) ? this._compactionBots : [];
    let limit = normalizePositiveInteger(options.limit, MAX_COMPACTION_BOTS);
    let offset = normalizeNonNegativeInteger(options.offset, 0);
    return bots.slice(offset, offset + limit);
  }

  // Refresh the synchronous compaction-bot snapshot from the store. Callers that
  // need the authoritative list (REST, toggles) await this.
  async refreshCompactionBots() {
    this._compactionBots = await this.attachTags(await this.agentStore.listCompactionBots({ limit: MAX_COMPACTION_BOTS }));
    return this._compactionBots;
  }

  // First designated compaction bot that is enabled and not excluded, mirroring
  // `resolveDefaultAgent` for the compaction-bot list. Returns null when none.
  async resolveCompactionBot(options = {}) {
    let exclude = new Set(normalizeStringArray(options.excludeAgentIDs));
    let tagged = await this.listTaggedAgents('compaction_score', {
      excludeAgentIDs: options.excludeAgentIDs,
      limit: options.limit || 500,
    });
    if (tagged.length > 0)
      return tagged[0];

    let bots = await this.agentStore.listCompactionBots({ limit: options.limit || 500 });
    for (let agent of bots) {
      if (agent.enabled === false || exclude.has(agent.id))
        continue;

      return agent;
    }

    return null;
  }

  // Resolve the default agent for a session: the first enabled master agent, in
  // master order (#1, then #2, ...). Agents listed in `excludeAgentIDs` (for
  // example ones that just errored) are skipped, so callers get master #2 as the
  // first backup, #3 as the second, and so on. Returns null when none qualify.
  async resolveDefaultAgent(options = {}) {
    let exclude = new Set(normalizeStringArray(options.excludeAgentIDs));
    let tagged = await this.listTaggedAgents('leadership_score', {
      excludeAgentIDs: options.excludeAgentIDs,
      limit: options.limit || 500,
    });
    if (tagged.length > 0)
      return tagged[0];

    let masters = await this.listMasterAgents({ limit: options.limit || 500 });
    for (let agent of masters) {
      if (agent.enabled === false || exclude.has(agent.id))
        continue;

      return agent;
    }

    return null;
  }

  async deleteAgent(agentID) {
    if (this.tagsStore?.deleteTagsForTarget)
      await this.tagsStore.deleteTagsForTarget('agent', agentID);
    await this.agentStore.deleteAgent(agentID);
  }

  async attachTags(agents = []) {
    let list = Array.isArray(agents) ? agents.filter(Boolean) : [];
    if (!this.tagsStore?.listTags || list.length === 0)
      return list;

    let byTarget = new Map();
    try {
      let result = await this.tagsStore.listTags({ target_type: 'agent', limit: 5000 });
      for (let tag of result.tags || []) {
        if (!byTarget.has(tag.target_id))
          byTarget.set(tag.target_id, []);
        byTarget.get(tag.target_id).push(tag);
      }
    } catch (_error) {}

    return list.map((agent) => ({
      ...agent,
      tags: byTarget.get(agent.id) || [],
    }));
  }

  async listTaggedAgents(name, options = {}) {
    if (!this.tagsStore?.listTags)
      return [];

    let excluded = new Set(normalizeStringArray(options.excludeAgentIDs));
    let result = await this.tagsStore.listTags({
      target_type: 'agent',
      name,
      min_value: options.minValue ?? 1,
      limit: Math.max(options.limit || 1000, 5000),
    });
    let valueByID = new Map((result.tags || []).map((tag) => [ tag.target_id, tagNumber(tag.value) ]));
    let agents = await this.listAgents({ limit: options.limit || 500 });
    return agents
      .filter((agent) => agent.enabled !== false && !excluded.has(agent.id) && (valueByID.get(agent.id) || 0) > 0)
      .map((agent) => ({ ...agent, tagValue: valueByID.get(agent.id) || 0 }))
      .sort((a, b) => b.tagValue - a.tagValue || String(a.name).localeCompare(String(b.name)));
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

    let errors = [];
    for (let key of Object.keys(config || {})) {
      if (!configFields.has(key))
        errors.push(unknownFieldMessage('config', input.pluginID, key, [ ...configFields ]));
    }

    for (let key of Object.keys(secrets)) {
      if (!secretFields.has(key))
        errors.push(unknownFieldMessage('secret', input.pluginID, key, [ ...secretFields ]));
    }

    if (Array.isArray(input.clearSecrets)) {
      for (let key of input.clearSecrets) {
        if (!secretFields.has(key))
          errors.push(unknownFieldMessage('secret', input.pluginID, key, [ ...secretFields ]));
      }
    }

    if (options.creating) {
      // A provider default satisfies a required field. Applying defaults before
      // the required pass avoids the old "required" error for a field the
      // provider itself declares a value for.
      for (let field of fields) {
        let source = field.secret ? secrets : config;
        if (source[field.name] == null && field.defaultValue !== undefined)
          source[field.name] = field.defaultValue;
      }

      let missing = [];
      for (let field of fields) {
        if (!field.required)
          continue;
        let source = field.secret ? secrets : config;
        if (source[field.name] == null || source[field.name] === '')
          missing.push(`${field.name} is required`);
      }
      if (missing.length > 0)
        errors.push(`Missing required fields: ${missing.join(', ')}`);
    }

    if (errors.length > 0)
      throw badRequest(errors.join('; '));

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

    let hasTags = Object.hasOwn(input, 'tags');
    let tags = hasTags
      ? normalizeTagInputList(input.tags, {
        targetType: 'agent',
        targetID: options.creating ? '' : input.id || '',
        definitions: this.listTagDefinitions(),
      })
      : undefined;

    return withoutUndefined({
      name: input.name,
      pluginID: input.pluginID,
      character,
      [CHARACTER_COMPRESSED_FIELD]: characterCompressed,
      config,
      secrets,
      clearSecrets: input.clearSecrets,
      enabled: input.enabled,
      tags,
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

function normalizePositiveInteger(value, fallback) {
  if (value == null)
    return fallback;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value == null)
    return fallback;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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

function unknownFieldMessage(kind, pluginID, key, fields = []) {
  let suggestion = closestField(key, fields);
  return `Unknown ${kind} field for ${pluginID}: ${key}${suggestion ? ` (did you mean ${suggestion}?)` : ''}`;
}

function closestField(key, fields = []) {
  let lower = String(key).toLowerCase();
  let exact = fields.find((field) => field.toLowerCase() === lower);
  if (exact)
    return exact;

  let best = null;
  let bestDistance = Infinity;
  for (let field of fields) {
    let distance = editDistance(lower, field.toLowerCase());
    if (distance < bestDistance) {
      best = field;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(String(key).length / 2)) ? best : null;
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let current = [ i ];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function badRequest(message) {
  let error = new Error(message);
  error.status = 400;
  return error;
}
