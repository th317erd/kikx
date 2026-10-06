'use strict';

import { createHash, randomUUID } from 'node:crypto';

import { pathsFromItems, readJSONFiles } from './aeordb-file-utils.mjs';
import { writeIndexConfigs } from '../database/index-configs.mjs';

const DEFAULT_ROOT_PATH = '/kikx';

export class AeorDBTeamStore {
  constructor(options = {}) {
    let db = options.db || options.aeordb;
    let {
      rootPath = DEFAULT_ROOT_PATH,
      clock = () => Date.now(),
      idGenerator = () => randomUUID(),
    } = options;

    if (!db)
      throw new TypeError('AeorDBTeamStore requires db (or the aeordb alias)');

    this.aeordb = db;
    this.db = db;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
    this.idGenerator = idGenerator;
    this._indexesReady = false;
  }

  async createTeam(input = {}) {
    await this.ensureIndexConfigs();

    let now = this.clock();
    let team = normalizeTeam({
      id: input.id || this.idGenerator(),
      name: input.name,
      members: input.members || [],
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    });

    await this.saveTeam(team);
    return sanitizeTeam(team);
  }

  async listTeams(options = {}) {
    await this.ensureIndexConfigs();

    let result;
    try {
      result = await this.aeordb.listDirectory(`${this.rootPath}/teams`, {
        depth: -1,
        glob: '**/team.json',
        limit: normalizeLimit(options.limit, 50),
        offset: normalizeOffset(options.offset),
      });
    } catch (error) {
      if (error.status === 404)
        return [];

      throw error;
    }

    let teams = [];
    let reads = await readJSONFiles(this.aeordb, pathsFromItems(result?.items), {
      fallbackOnBatchError: true,
    });

    for (let read of reads) {
      let team = read.value;
      if (team?.id)
        teams.push(sanitizeTeam(team));
    }

    return teams;
  }

  async getTeam(teamID) {
    let team = await this.loadTeam(teamID);
    if (!team?.id)
      throw notFound(teamID);

    return sanitizeTeam(team);
  }

  async findTeamByIDOrName(reference) {
    if (typeof reference !== 'string' || reference.trim() === '')
      throw new TypeError('findTeamByIDOrName() requires a non-empty reference');

    await this.ensureIndexConfigs();

    try {
      return await this.getTeam(reference);
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }

    let lookupMatches = await this.findTeamsByNameLookup(reference);
    if (lookupMatches.length > 1)
      throw ambiguousName(reference);

    if (lookupMatches.length === 1)
      return lookupMatches[0];

    // A driver without the query capability hides the adapter entirely, so
    // skip straight to the bounded-list fallback instead of calling a missing
    // method. Real query errors still fall through to the 404 branch below.
    if (typeof this.aeordb.queryFiles !== 'function') {
      let legacyMatch = await this.findTeamByNameFromBoundedList(reference);
      if (legacyMatch)
        await this.saveTeamNameLookup(legacyMatch);

      return legacyMatch;
    }

    let result;
    try {
      result = await this.aeordb.queryFiles({
        path: `${this.rootPath}/teams`,
        where: { field: 'nameKey', op: 'eq', value: normalizeTeamNameForLookup(reference) },
        limit: 2,
        select: [ '@path' ],
      });
    } catch (error) {
      if (error.status !== 404)
        throw error;

      let legacyMatch = await this.findTeamByNameFromBoundedList(reference);
      if (legacyMatch)
        await this.saveTeamNameLookup(legacyMatch);

      return legacyMatch;
    }

    let paths = [];
    for (let item of result?.results || result?.items || []) {
      let path = item.path || item['@path'];
      if (path)
        paths.push(path);
    }

    let teams = [];
    let reads = await readJSONFiles(this.aeordb, paths, {
      fallbackOnBatchError: true,
    });

    for (let read of reads) {
      let team = read.value;
      if (team?.id)
        teams.push(sanitizeTeam(team));
    }

    if (teams.length > 1)
      throw ambiguousName(reference);

    if (teams.length === 1)
      return teams[0];

    let legacyMatch = await this.findTeamByNameFromBoundedList(reference);
    if (legacyMatch)
      await this.saveTeamNameLookup(legacyMatch);

    return legacyMatch;
  }

  async findTeamsByNameLookup(reference) {
    let result;
    try {
      result = await this.aeordb.listDirectory(this.teamNameLookupDir(reference), {
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
    let referenceKey = normalizeTeamNameForLookup(reference);

    for (let read of reads) {
      let teamID = read.value?.teamID;
      if (!teamID)
        continue;

      let team;
      try {
        team = await this.loadTeam(teamID);
      } catch (error) {
        if (error.status !== 404)
          throw error;
      }

      if (team?.id && normalizeTeamNameForLookup(team.name) === referenceKey)
        matches.push(sanitizeTeam(team));
    }

    return matches;
  }

  async findTeamByNameFromBoundedList(reference) {
    let teams = await this.listTeams({ limit: 500 });
    let referenceKey = normalizeTeamNameForLookup(reference);
    let matches = teams.filter((team) => normalizeTeamNameForLookup(team.name) === referenceKey);

    if (matches.length > 1)
      throw ambiguousName(reference);

    return matches[0] || null;
  }

  async updateTeam(teamID, input = {}) {
    await this.ensureIndexConfigs();

    let team = await this.loadTeam(teamID);
    if (!team?.id)
      throw notFound(teamID);

    let next = normalizeTeam({
      ...team,
      name: input.name ?? team.name,
      members: input.members ?? team.members ?? [],
      updatedAt: input.updatedAt || this.clock(),
    });

    await this.saveTeam(next, team);
    return sanitizeTeam(next);
  }

  async deleteTeam(teamID) {
    await this.ensureIndexConfigs();

    let team = await this.loadTeam(teamID);
    if (!team?.id)
      throw notFound(teamID);

    await this.aeordb.deleteFile(this.teamPath(teamID));
    await this.deleteTeamNameLookup(team);
  }

  async saveTeam(team, previousTeam = null) {
    if (!team?.id)
      throw new TypeError('saveTeam() requires team.id');

    await this.aeordb.putFile(this.teamPath(team.id), {
      ...team,
      nameKey: normalizeTeamNameForLookup(team.name),
      memberActorIDs: normalizeTeamMembers(team.members).map((member) => member.actorID),
      memberTypes: normalizeTeamMembers(team.members).map((member) => member.type),
    });
    await this.saveTeamNameLookup(team);

    if (previousTeam?.id && this.teamNameLookupPath(previousTeam.id, previousTeam.name) !== this.teamNameLookupPath(team.id, team.name))
      await this.deleteTeamNameLookup(previousTeam);
  }

  async loadTeam(teamID) {
    if (!teamID)
      throw new TypeError('loadTeam() requires teamID');

    return await this.aeordb.getFile(this.teamPath(teamID));
  }

  async ensureIndexConfigs() {
    if (this._indexesReady)
      return;

    await writeIndexConfigs(this.db, [
      {
        path: `${this.rootPath}/teams/.aeordb-config/indexes.json`,
        body: {
          glob: '*/team.json',
          indexes: [
            { name: 'id', type: 'string' },
            { name: 'name', type: [ 'string', 'trigram' ] },
            { name: 'nameKey', type: 'string' },
            { name: 'memberActorIDs', type: 'string' },
            { name: 'memberTypes', type: 'string' },
            { name: 'createdAt', type: 'timestamp' },
            { name: 'updatedAt', type: 'timestamp' },
          ],
        },
      },
    ]);
    this._indexesReady = true;
  }

  teamPath(teamID) {
    return `${this.rootPath}/teams/${encodeSegment(teamID)}/team.json`;
  }

  teamNameLookupDir(name) {
    return `${this.rootPath}/team-name-lookup/${teamNameLookupHash(name)}`;
  }

  teamNameLookupPath(teamID, name) {
    return `${this.teamNameLookupDir(name)}/${encodeSegment(teamID)}.json`;
  }

  async saveTeamNameLookup(team) {
    await this.aeordb.putFile(this.teamNameLookupPath(team.id, team.name), {
      teamID: team.id,
      name: team.name,
      nameKey: normalizeTeamNameForLookup(team.name),
      updatedAt: team.updatedAt || null,
    });
  }

  async deleteTeamNameLookup(team) {
    try {
      await this.aeordb.deleteFile(this.teamNameLookupPath(team.id, team.name));
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }
  }
}

export function sanitizeTeam(team) {
  return {
    id: team.id,
    name: team.name,
    members: normalizeTeamMembers(team.members),
    createdAt: team.createdAt || null,
    updatedAt: team.updatedAt || null,
  };
}

export function normalizeTeamMember(input = {}) {
  let type = normalizeRequiredString(input.type, 'member.type').toLowerCase();
  if (type !== 'agent' && type !== 'user')
    throw new TypeError('member.type must be agent or user');

  let actorID = normalizeRequiredString(input.actorID || input.id || input.agentID || input.userID, 'member.actorID');
  return withoutUndefined({
    actorID,
    type,
    name: normalizeOptionalString(input.name),
    username: normalizeOptionalString(input.username),
    fullName: normalizeOptionalString(input.fullName),
    email: normalizeOptionalString(input.email),
  });
}

function normalizeTeam(team) {
  return {
    id: normalizeRequiredString(team.id, 'team.id'),
    name: normalizeRequiredString(team.name, 'name'),
    members: normalizeTeamMembers(team.members),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function normalizeTeamMembers(members) {
  if (!Array.isArray(members))
    throw new TypeError('members must be an array');

  let output = [];
  let seen = new Set();
  for (let member of members) {
    let normalized = normalizeTeamMember(member);
    let key = `${normalized.type}:${normalized.actorID}`;
    if (seen.has(key))
      continue;

    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function normalizeTeamNameForLookup(name) {
  return normalizeRequiredString(name, 'name').toLowerCase();
}

function teamNameLookupHash(name) {
  return createHash('sha256')
    .update(normalizeTeamNameForLookup(name))
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

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function withoutUndefined(value) {
  let output = {};
  for (let [key, item] of Object.entries(value)) {
    if (item !== '')
      output[key] = item;
  }
  return output;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function ambiguousName(reference) {
  let error = new Error(`Ambiguous team name: ${reference}`);
  error.status = 400;
  return error;
}

function notFound(teamID) {
  let error = new Error(`Unknown team: ${teamID}`);
  error.status = 404;
  return error;
}
