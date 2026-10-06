'use strict';

import { createHash, randomUUID } from 'node:crypto';

import { pathsFromItems, readJSONFiles } from './aeordb-file-utils.mjs';
import { HybridLogicalClock } from '../clock/hybrid-logical-clock.mjs';
import {
  CHARACTER_COMPRESSED_FIELD,
  MAX_CHARACTER_COMPRESSED_LENGTH,
} from '../agents/character-limits.mjs';
import { writeIndexConfigs } from '../database/index-configs.mjs';

const DEFAULT_ROOT_PATH = '/kikx';
// The master-agent list is exactly the most-recently-crowned three. Crowning a
// fourth evicts (uncrowns) the oldest, so storage never keeps stale masters.
export const MAX_MASTER_AGENTS = 3;
// The compaction-bot list is a parallel rolling top-3. It uses its own fields
// (`compactionCrownedAt`/`compactionCrownedClock`) so the two lists never
// interfere: crowning a master never changes the compaction-bot list, and vice
// versa. Same cap as the crown for identical behavior.
export const MAX_COMPACTION_BOTS = 3;

export class AeorDBAgentStore {
  constructor(options = {}) {
    let db = options.db || options.aeordb;
    let {
      rootPath = DEFAULT_ROOT_PATH,
      clock = () => Date.now(),
      logicalClock = null,
      idGenerator = () => randomUUID(),
    } = options;

    if (!db)
      throw new TypeError('AeorDBAgentStore requires db (or the aeordb alias)');

    this.aeordb = db;
    this.db = db;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
    // High-resolution, monotonic source for "crowned_at" ordering: the HLC tick
    // yields a microsecond physical timestamp plus a logical counter, so rapid
    // crowns still get a strict, stable order.
    this.logicalClock = logicalClock || new HybridLogicalClock();
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
      character: input.character || '',
      [CHARACTER_COMPRESSED_FIELD]: input[CHARACTER_COMPRESSED_FIELD] || '',
      config: input.config || {},
      secrets: input.secrets || {},
      enabled: input.enabled !== false,
      crownedAt: null,
      crownedClock: null,
      compactionCrownedAt: null,
      compactionCrownedClock: null,
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
    let reads = await readJSONFiles(this.aeordb, pathsFromItems(result?.items), {
      fallbackOnBatchError: true,
    });

    for (let read of reads) {
      let agent = read.value;
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

    let lookupMatches = await this.findAgentsByNameLookup(reference);
    if (lookupMatches.length > 1)
      throw ambiguousName(reference);

    if (lookupMatches.length === 1)
      return lookupMatches[0];

    // A driver without the query capability hides the adapter entirely, so
    // skip straight to the bounded-list fallback instead of calling a missing
    // method. Real query errors still fall through to the 404 branch below.
    if (typeof this.aeordb.queryFiles !== 'function') {
      let legacyMatch = await this.findAgentByNameFromBoundedList(reference);
      if (legacyMatch)
        await this.saveAgentNameLookup(legacyMatch);

      return legacyMatch;
    }

    let result;
    try {
      result = await this.aeordb.queryFiles({
        path: `${this.rootPath}/agents`,
        where: { field: 'nameKey', op: 'eq', value: normalizeAgentNameForLookup(reference) },
        limit: 2,
        select: [ '@path' ],
      });
    } catch (error) {
      if (error.status !== 404)
        throw error;

      let legacyMatch = await this.findAgentByNameFromBoundedList(reference);
      if (legacyMatch)
        await this.saveAgentNameLookup(legacyMatch);

      return legacyMatch;
    }

    let paths = [];
    for (let item of result?.results || result?.items || []) {
      let path = item.path || item['@path'];
      if (path)
        paths.push(path);
    }

    let agents = [];
    let reads = await readJSONFiles(this.aeordb, paths, {
      fallbackOnBatchError: true,
    });

    for (let read of reads) {
      let agent = read.value;
      if (agent?.id)
        agents.push(sanitizeAgent(agent));
    }

    if (agents.length > 1)
      throw ambiguousName(reference);

    if (agents.length === 1)
      return agents[0];

    let legacyMatch = await this.findAgentByNameFromBoundedList(reference);
    if (legacyMatch)
      await this.saveAgentNameLookup(legacyMatch);

    return legacyMatch;
  }

  async findAgentsByNameLookup(reference) {
    let result;
    try {
      result = await this.aeordb.listDirectory(this.agentNameLookupDir(reference), {
        depth: 1,
        glob: '*.json',
        limit: 2,
      });
    } catch (error) {
      if (error.status === 404)
        return [];

      throw error;
    }

    let reads = await readJSONFiles(this.aeordb, pathsFromItems(result?.items), {
      fallbackOnBatchError: true,
    });
    let matches = [];
    let referenceKey = normalizeAgentNameForLookup(reference);

    for (let read of reads) {
      let agentID = read.value?.agentID;
      if (!agentID)
        continue;

      let agent;
      try {
        agent = await this.loadAgent(agentID);
      } catch (error) {
        if (error.status !== 404)
          throw error;
      }

      if (agent?.id && normalizeAgentNameForLookup(agent.name) === referenceKey)
        matches.push(sanitizeAgent(agent));
    }

    return matches;
  }

  async findAgentByNameFromBoundedList(reference) {
    let agents = await this.listAgents({ limit: 500 });
    let referenceKey = normalizeAgentNameForLookup(reference);
    let matches = agents.filter((agent) => normalizeAgentNameForLookup(agent.name) === referenceKey);

    if (matches.length > 1)
      throw ambiguousName(reference);

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
      character: input.character ?? agent.character ?? '',
      [CHARACTER_COMPRESSED_FIELD]: input[CHARACTER_COMPRESSED_FIELD] ?? agent[CHARACTER_COMPRESSED_FIELD] ?? '',
      config: input.config ?? agent.config ?? {},
      secrets: mergeSecrets(agent.secrets, input.secrets, input.clearSecrets),
      enabled: input.enabled ?? agent.enabled,
      crownedAt: agent.crownedAt ?? null,
      crownedClock: agent.crownedClock ?? null,
      compactionCrownedAt: agent.compactionCrownedAt ?? null,
      compactionCrownedClock: agent.compactionCrownedClock ?? null,
      updatedAt: input.updatedAt || this.clock(),
    });

    await this.saveAgent(next, agent);
    return sanitizeAgent(next);
  }

  // Crown (master agent) or uncrown an agent. Crowned agents are ordered by
  // crownedClock descending: the newest crown is master #1, the next #2, etc.
  // Uncrowning clears the crown; re-crowning a previously crowned agent moves it
  // to the front (a fresh crowned_at), which is the intuitive "crown now" action.
  async setAgentCrowned(agentID, crowned = true) {
    await this.ensureIndexConfigs();

    let agent = await this.loadAgent(agentID);
    if (!agent?.id)
      throw notFound(agentID);

    let wasCrowned = Boolean(agent.crownedClock);
    let isCrowned = crowned === true;

    if (isCrowned && wasCrowned) {
      // Already crowned and asking to crown again: no-op (idempotent), so a
      // double click does not reorder masters.
      return sanitizeAgent(agent);
    }

    let crownedAt = null;
    let crownedClock = null;
    if (isCrowned) {
      let stamp = this.nextCrownStamp();
      crownedAt = stamp.at;
      crownedClock = stamp.clock;
    }

    let next = normalizeAgent({
      ...agent,
      crownedAt,
      crownedClock,
      updatedAt: this.clock(),
    });

    await this.saveAgent(next, agent);

    // Crowning keeps at most MAX_MASTER_AGENTS masters: the oldest crown beyond
    // the cap is evicted (uncrowned). The master set is a rolling top-N.
    if (isCrowned)
      await this.evictExcessMasters(agentID);

    return sanitizeAgent(await this.loadAgent(agentID));
  }

  async evictExcessMasters(keepAgentID) {
    // Use the UNCAPPED crowned list: listMasterAgents() itself caps at
    // MAX_MASTER_AGENTS, so it can never reveal the overflow to evict.
    let masters = await this.readCrownedAgents();
    let overflow = masters.slice(MAX_MASTER_AGENTS);
    for (let old of overflow) {
      if (old.id === keepAgentID)
        continue;

      let loaded = await this.loadAgent(old.id);
      if (!loaded?.id)
        continue;

      await this.saveAgent(normalizeAgent({ ...loaded, crownedAt: null, crownedClock: null, updatedAt: this.clock() }), loaded);
    }
  }

  // All crowned agents, newest first, uncapped. Internal ordering source.
  async readCrownedAgents() {
    let agents = await this.listAgents({ limit: 500 });
    return agents
      .filter((agent) => Boolean(agent.crownedClock))
      .sort(compareMasterOrder);
  }

  // Master agents (crowned), most recently crowned first (master #1 first).
  // At most MAX_MASTER_AGENTS by construction; limit can only narrow further.
  async listMasterAgents(options = {}) {
    await this.ensureIndexConfigs();

    let limit = Math.min(normalizeLimit(options.limit, MAX_MASTER_AGENTS), MAX_MASTER_AGENTS);
    let offset = normalizeOffset(options.offset);
    let masters = await this.readCrownedAgents();
    return masters.slice(offset, offset + limit);
  }

  nextCrownStamp() {
    return this.logicalClock.tick();
  }

  // Compaction-bot designation: a rolling top-3 parallel to the crown, but with
  // its own fields so the two lists are fully independent. Crowning a master
  // never changes the compaction-bot list and vice versa.
  async setAgentCompactionBotCrowned(agentID, crowned = true) {
    await this.ensureIndexConfigs();

    let agent = await this.loadAgent(agentID);
    if (!agent?.id)
      throw notFound(agentID);

    let wasCrowned = Boolean(agent.compactionCrownedClock);
    let isCrowned = crowned === true;

    if (isCrowned && wasCrowned) {
      // Idempotent re-designation must not reorder the list.
      return sanitizeAgent(agent);
    }

    let compactionCrownedAt = null;
    let compactionCrownedClock = null;
    if (isCrowned) {
      let stamp = this.nextCompactionCrownStamp();
      compactionCrownedAt = stamp.at;
      compactionCrownedClock = stamp.clock;
    }

    let next = normalizeAgent({
      ...agent,
      compactionCrownedAt,
      compactionCrownedClock,
      updatedAt: this.clock(),
    });

    await this.saveAgent(next, agent);

    if (isCrowned)
      await this.evictExcessCompactionBots(agentID);

    return sanitizeAgent(await this.loadAgent(agentID));
  }

  async evictExcessCompactionBots(keepAgentID) {
    // Uncapped read: listCompactionBots() itself caps at MAX_COMPACTION_BOTS,
    // so it can never reveal the overflow to evict.
    let bots = await this.readCompactionBotCrowned();
    let overflow = bots.slice(MAX_COMPACTION_BOTS);
    for (let old of overflow) {
      if (old.id === keepAgentID)
        continue;

      let loaded = await this.loadAgent(old.id);
      if (!loaded?.id)
        continue;

      await this.saveAgent(normalizeAgent({ ...loaded, compactionCrownedAt: null, compactionCrownedClock: null, updatedAt: this.clock() }), loaded);
    }
  }

  // All compaction-bot-crowned agents, newest first, uncapped. Ordering source.
  async readCompactionBotCrowned() {
    let agents = await this.listAgents({ limit: 500 });
    return agents
      .filter((agent) => Boolean(agent.compactionCrownedClock))
      .sort(compareCompactionBotOrder);
  }

  // Compaction bots, most recently designated first (#1 first), capped at
  // MAX_COMPACTION_BOTS by construction. The ordering source for rung 2 of
  // compactor selection.
  async listCompactionBots(options = {}) {
    await this.ensureIndexConfigs();

    let limit = Math.min(normalizeLimit(options.limit, MAX_COMPACTION_BOTS), MAX_COMPACTION_BOTS);
    let offset = normalizeOffset(options.offset);
    let bots = await this.readCompactionBotCrowned();
    return bots.slice(offset, offset + limit);
  }

  nextCompactionCrownStamp() {
    return this.logicalClock.tick();
  }

  async deleteAgent(agentID) {
    await this.ensureIndexConfigs();

    let agent = await this.loadAgent(agentID);
    if (!agent?.id)
      throw notFound(agentID);

    await this.aeordb.deleteFile(this.agentPath(agentID));
    await this.deleteAgentNameLookup(agent);
  }

  async saveAgent(agent, previousAgent = null) {
    if (!agent?.id)
      throw new TypeError('saveAgent() requires agent.id');

    await this.aeordb.putFile(this.agentPath(agent.id), {
      ...agent,
      nameKey: normalizeAgentNameForLookup(agent.name),
      enabledIndex: String(agent.enabled !== false),
      crownedIndex: String(Boolean(agent.crownedClock)),
      compactionCrownedIndex: String(Boolean(agent.compactionCrownedClock)),
    });
    await this.saveAgentNameLookup(agent);

    if (previousAgent?.id && this.agentNameLookupPath(previousAgent.id, previousAgent.name) !== this.agentNameLookupPath(agent.id, agent.name))
      await this.deleteAgentNameLookup(previousAgent);
  }

  async loadAgent(agentID) {
    if (!agentID)
      throw new TypeError('loadAgent() requires agentID');

    return await this.aeordb.getFile(this.agentPath(agentID));
  }

  async ensureIndexConfigs() {
    if (this._indexesReady)
      return;

    await writeIndexConfigs(this.db, [
      {
        path: `${this.rootPath}/agents/.aeordb-config/indexes.json`,
        body: {
          glob: '*/agent.json',
          indexes: [
            { name: 'id', type: 'string' },
            { name: 'name', type: [ 'string', 'trigram' ] },
            { name: 'nameKey', type: 'string' },
            { name: 'pluginID', type: 'string' },
            { name: 'enabled', type: 'string', source: [ 'enabledIndex' ] },
            { name: 'crowned', type: 'string', source: [ 'crownedIndex' ] },
            { name: 'crownedAt', type: 'timestamp' },
            { name: 'crownedClock', type: 'string' },
            { name: 'compactionCrowned', type: 'string', source: [ 'compactionCrownedIndex' ] },
            { name: 'compactionCrownedAt', type: 'timestamp' },
            { name: 'compactionCrownedClock', type: 'string' },
            { name: 'createdAt', type: 'timestamp' },
            { name: 'updatedAt', type: 'timestamp' },
          ],
        },
      },
    ]);
    this._indexesReady = true;
  }

  agentPath(agentID) {
    return `${this.rootPath}/agents/${encodeSegment(agentID)}/agent.json`;
  }

  agentNameLookupDir(name) {
    return `${this.rootPath}/agent-name-lookup/${agentNameLookupHash(name)}`;
  }

  agentNameLookupPath(agentID, name) {
    return `${this.agentNameLookupDir(name)}/${encodeSegment(agentID)}.json`;
  }

  async saveAgentNameLookup(agent) {
    await this.aeordb.putFile(this.agentNameLookupPath(agent.id, agent.name), {
      agentID: agent.id,
      name: agent.name,
      nameKey: normalizeAgentNameForLookup(agent.name),
      updatedAt: agent.updatedAt || null,
    });
  }

  async deleteAgentNameLookup(agent) {
    try {
      await this.aeordb.deleteFile(this.agentNameLookupPath(agent.id, agent.name));
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }
  }
}

export function sanitizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    pluginID: agent.pluginID,
    character: normalizeOptionalString(agent.character, 'character'),
    [CHARACTER_COMPRESSED_FIELD]: normalizeCompressedCharacter(agent[CHARACTER_COMPRESSED_FIELD]),
    config: isPlainObject(agent.config) ? { ...agent.config } : {},
    secretState: secretState(agent.secrets),
    enabled: agent.enabled !== false,
    crownedAt: normalizeCrownTimestamp(agent.crownedAt),
    crownedClock: normalizeCrownClock(agent.crownedClock),
    compactionCrownedAt: normalizeCrownTimestamp(agent.compactionCrownedAt),
    compactionCrownedClock: normalizeCrownClock(agent.compactionCrownedClock),
    createdAt: agent.createdAt || null,
    updatedAt: agent.updatedAt || null,
  };
}

function normalizeAgent(agent) {
  return {
    id: normalizeRequiredString(agent.id, 'agent.id'),
    name: normalizeRequiredString(agent.name, 'name'),
    pluginID: normalizeRequiredString(agent.pluginID, 'pluginID'),
    character: normalizeOptionalString(agent.character, 'character'),
    [CHARACTER_COMPRESSED_FIELD]: normalizeCompressedCharacter(agent[CHARACTER_COMPRESSED_FIELD]),
    config: normalizePlainObject(agent.config, 'config'),
    secrets: normalizePlainObject(agent.secrets, 'secrets'),
    enabled: agent.enabled !== false,
    crownedAt: normalizeCrownTimestamp(agent.crownedAt),
    crownedClock: normalizeCrownClock(agent.crownedClock),
    compactionCrownedAt: normalizeCrownTimestamp(agent.compactionCrownedAt),
    compactionCrownedClock: normalizeCrownClock(agent.compactionCrownedClock),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function normalizeCrownTimestamp(value) {
  let number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function normalizeCrownClock(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// Master order: newest crowned_at first. crownedClock is a lexicographically
// sortable HLC string; crownedAt breaks any HLC ties. Descending.
function compareMasterOrder(a, b) {
  return String(b.crownedClock || '').localeCompare(String(a.crownedClock || ''))
    || (Number(b.crownedAt || 0) - Number(a.crownedAt || 0))
    || String(a.id).localeCompare(String(b.id));
}

// Compaction-bot order: identical to master order but over the parallel fields.
function compareCompactionBotOrder(a, b) {
  return String(b.compactionCrownedClock || '').localeCompare(String(a.compactionCrownedClock || ''))
    || (Number(b.compactionCrownedAt || 0) - Number(a.compactionCrownedAt || 0))
    || String(a.id).localeCompare(String(b.id));
}

function normalizeAgentNameForLookup(name) {
  return normalizeRequiredString(name, 'name').toLowerCase();
}

function agentNameLookupHash(name) {
  return createHash('sha256')
    .update(normalizeAgentNameForLookup(name))
    .digest('base64url');
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

function normalizeOptionalString(value, fieldName) {
  if (value == null)
    return '';

  if (typeof value !== 'string')
    throw new TypeError(`${fieldName} must be a string`);

  return value.trim();
}

// Optional at the storage boundary (pre-P6 records load fine), but bounded when
// present. The self-service tool enforces a non-empty value at its own boundary.
function normalizeCompressedCharacter(value) {
  let normalized = normalizeOptionalString(value, CHARACTER_COMPRESSED_FIELD);
  if (normalized === '')
    return '';

  if (normalized.length > MAX_CHARACTER_COMPRESSED_LENGTH)
    throw new TypeError(`${CHARACTER_COMPRESSED_FIELD} must be ${MAX_CHARACTER_COMPRESSED_LENGTH} characters or fewer`);

  return normalized;
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

function ambiguousName(reference) {
  let error = new Error(`Ambiguous agent name: ${reference}`);
  error.status = 400;
  return error;
}

function notFound(agentID) {
  let error = new Error(`Unknown agent: ${agentID}`);
  error.status = 404;
  return error;
}
