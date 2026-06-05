'use strict';

import { randomUUID } from 'node:crypto';

const DEFAULT_ROOT_PATH = '/kikx';

export class AeorDBAgentStore {
  constructor(options = {}) {
    let {
      aeordb,
      rootPath = DEFAULT_ROOT_PATH,
      clock = () => Date.now(),
      idGenerator = () => randomUUID(),
    } = options;

    if (!aeordb)
      throw new TypeError('AeorDBAgentStore requires an aeordb client');

    this.aeordb = aeordb;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
    this.idGenerator = idGenerator;
    this._indexesReady = false;
  }

  async createAgent(input = {}) {
    await this.ensureIndexConfigs();

    let now = this.clock();
    let agent = normalizeAgent({
      id: input.id || this.idGenerator(),
      name: input.name,
      pluginID: input.pluginID,
      config: input.config || {},
      secrets: input.secrets || {},
      enabled: input.enabled !== false,
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    });

    await this.saveAgent(agent);
    return sanitizeAgent(agent);
  }

  async listAgents(options = {}) {
    await this.ensureIndexConfigs();

    let result;
    try {
      result = await this.aeordb.listDirectory(`${this.rootPath}/agents`, {
        depth: -1,
        glob: '**/agent.json',
        limit: normalizeLimit(options.limit, 50),
        offset: normalizeOffset(options.offset),
      });
    } catch (error) {
      if (error.status === 404)
        return [];

      throw error;
    }

    let agents = [];
    for (let item of result?.items || []) {
      if (!item?.path)
        continue;

      let agent = await this.aeordb.getFile(item.path);
      if (agent?.id)
        agents.push(sanitizeAgent(agent));
    }

    return agents;
  }

  async getAgent(agentID, options = {}) {
    let agent = await this.loadAgent(agentID);
    if (!agent?.id)
      throw notFound(agentID);

    return options.includeSecrets ? agent : sanitizeAgent(agent);
  }

  async findAgentByIDOrName(reference) {
    if (typeof reference !== 'string' || reference.trim() === '')
      throw new TypeError('findAgentByIDOrName() requires a non-empty reference');

    await this.ensureIndexConfigs();

    try {
      return await this.getAgent(reference);
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }

    let result;
    try {
      result = await this.aeordb.queryFiles({
        path: `${this.rootPath}/agents`,
        where: { field: 'name', op: 'eq', value: reference.trim() },
        limit: 2,
        select: [ '@path' ],
      });
    } catch (error) {
      if (error.status !== 404)
        throw error;

      return await this.findAgentByNameFromBoundedList(reference);
    }

    let agents = [];
    for (let item of result?.results || result?.items || []) {
      let path = item.path || item['@path'];
      if (!path)
        continue;

      let agent = await this.aeordb.getFile(path);
      if (agent?.id)
        agents.push(sanitizeAgent(agent));
    }

    if (agents.length > 1) {
      let error = new Error(`Ambiguous agent name: ${reference}`);
      error.status = 400;
      throw error;
    }

    return agents[0] || null;
  }

  async findAgentByNameFromBoundedList(reference) {
    let agents = await this.listAgents({ limit: 500 });
    let matches = agents.filter((agent) => agent.name === reference.trim());

    if (matches.length > 1) {
      let error = new Error(`Ambiguous agent name: ${reference}`);
      error.status = 400;
      throw error;
    }

    return matches[0] || null;
  }

  async updateAgent(agentID, input = {}) {
    await this.ensureIndexConfigs();

    let agent = await this.loadAgent(agentID);
    if (!agent?.id)
      throw notFound(agentID);

    let next = normalizeAgent({
      ...agent,
      name: input.name ?? agent.name,
      pluginID: input.pluginID ?? agent.pluginID,
      config: input.config ?? agent.config ?? {},
      secrets: mergeSecrets(agent.secrets, input.secrets, input.clearSecrets),
      enabled: input.enabled ?? agent.enabled,
      updatedAt: input.updatedAt || this.clock(),
    });

    await this.saveAgent(next);
    return sanitizeAgent(next);
  }

  async deleteAgent(agentID) {
    await this.ensureIndexConfigs();

    let agent = await this.loadAgent(agentID);
    if (!agent?.id)
      throw notFound(agentID);

    await this.aeordb.deleteFile(this.agentPath(agentID));
  }

  async saveAgent(agent) {
    if (!agent?.id)
      throw new TypeError('saveAgent() requires agent.id');

    await this.aeordb.putFile(this.agentPath(agent.id), {
      ...agent,
      enabledIndex: String(agent.enabled !== false),
    });
  }

  async loadAgent(agentID) {
    if (!agentID)
      throw new TypeError('loadAgent() requires agentID');

    return await this.aeordb.getFile(this.agentPath(agentID));
  }

  async ensureIndexConfigs() {
    if (this._indexesReady)
      return;

    await this.aeordb.putFile(`${this.rootPath}/agents/.aeordb-config/indexes.json`, {
      glob: '*/agent.json',
      indexes: [
        { name: 'id', type: 'string' },
        { name: 'name', type: [ 'string', 'trigram' ] },
        { name: 'pluginID', type: 'string' },
        { name: 'enabled', type: 'string', source: [ 'enabledIndex' ] },
        { name: 'createdAt', type: 'timestamp' },
        { name: 'updatedAt', type: 'timestamp' },
      ],
    });
    this._indexesReady = true;
  }

  agentPath(agentID) {
    return `${this.rootPath}/agents/${encodeSegment(agentID)}/agent.json`;
  }
}

export function sanitizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    pluginID: agent.pluginID,
    config: isPlainObject(agent.config) ? { ...agent.config } : {},
    secretState: secretState(agent.secrets),
    enabled: agent.enabled !== false,
    createdAt: agent.createdAt || null,
    updatedAt: agent.updatedAt || null,
  };
}

function normalizeAgent(agent) {
  return {
    id: normalizeRequiredString(agent.id, 'agent.id'),
    name: normalizeRequiredString(agent.name, 'name'),
    pluginID: normalizeRequiredString(agent.pluginID, 'pluginID'),
    config: normalizePlainObject(agent.config, 'config'),
    secrets: normalizePlainObject(agent.secrets, 'secrets'),
    enabled: agent.enabled !== false,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  return `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizePlainObject(value, fieldName) {
  if (!isPlainObject(value))
    throw new TypeError(`${fieldName} must be an object`);

  return { ...value };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergeSecrets(existing = {}, incoming = null, clearSecrets = []) {
  let next = isPlainObject(existing) ? { ...existing } : {};

  for (let key of Array.isArray(clearSecrets) ? clearSecrets : [])
    delete next[key];

  if (incoming != null) {
    if (!isPlainObject(incoming))
      throw new TypeError('secrets must be an object');

    for (let [key, value] of Object.entries(incoming)) {
      if (value == null || value === '')
        continue;

      next[key] = value;
    }
  }

  return next;
}

function secretState(secrets) {
  let state = {};
  if (!isPlainObject(secrets))
    return state;

  for (let [key, value] of Object.entries(secrets)) {
    state[key] = {
      present: value != null && value !== '',
      last4: typeof value === 'string' ? value.slice(-4) : '',
    };
  }

  return state;
}

function normalizeLimit(value, fallback) {
  if (value == null)
    return fallback;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOffset(value) {
  if (value == null)
    return 0;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function notFound(agentID) {
  let error = new Error(`Unknown agent: ${agentID}`);
  error.status = 404;
  return error;
}
