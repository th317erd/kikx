'use strict';

import { AeorDBTeamStore } from '../aeordb/aeordb-team-store.mjs';

export class TeamManager {
  constructor(options = {}) {
    let { teamStore, aeordb, agentManager = null } = options;

    this.agentManager = agentManager;
    this.teamStore = teamStore || new AeorDBTeamStore({ aeordb });
  }

  async createTeam(input = {}) {
    let normalized = await this.normalizeInput(input, { creating: true });
    return await this.teamStore.createTeam(normalized);
  }

  async listTeams(options = {}) {
    return await this.teamStore.listTeams(options);
  }

  async getTeam(teamID) {
    return await this.teamStore.getTeam(teamID);
  }

  async resolveTeam(reference) {
    if (typeof reference !== 'string' || reference.trim() === '')
      throw badRequest('team reference must be a non-empty string');

    let ref = reference.trim();
    if (typeof this.teamStore.findTeamByIDOrName === 'function') {
      let team = await this.teamStore.findTeamByIDOrName(ref);
      if (team)
        return team;
    } else {
      try {
        let team = await this.teamStore.getTeam(ref);
        if (team?.id)
          return team;
      } catch (error) {
        if (error.status !== 404)
          throw error;
      }

      let teams = await this.teamStore.listTeams({ limit: 500 });
      let lowered = ref.toLowerCase();
      let matches = teams.filter((team) => team.name?.toLowerCase() === lowered);
      if (matches.length === 1)
        return matches[0];

      if (matches.length > 1)
        throw badRequest(`Ambiguous team name: ${ref}`);
    }

    let error = new Error(`Team not found: ${ref}`);
    error.status = 404;
    throw error;
  }

  async updateTeam(teamID, input = {}) {
    let normalized = await this.normalizeInput(input, { creating: false });
    return await this.teamStore.updateTeam(teamID, normalized);
  }

  async deleteTeam(teamID) {
    await this.teamStore.deleteTeam(teamID);
  }

  async addMember(teamID, input = {}) {
    let team = await this.teamStore.getTeam(teamID);
    let member = await this.normalizeMemberInput(input);
    let members = uniqueMembers([ ...(team.members || []), member ]);
    return await this.teamStore.updateTeam(teamID, { members });
  }

  async removeMember(teamID, input = {}) {
    let team = await this.teamStore.getTeam(teamID);
    let actorID = normalizeRequiredString(input.actorID || input.id || input.agentID || input.userID, 'actorID');
    let type = normalizeOptionalString(input.type).toLowerCase();
    let members = (team.members || []).filter((member) => {
      if (member.actorID !== actorID)
        return true;

      return type && member.type !== type;
    });

    return await this.teamStore.updateTeam(teamID, { members });
  }

  async normalizeInput(input = {}, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw badRequest('team body must be an object');

    let output = {};
    if (options.creating || input.name !== undefined)
      output.name = normalizeRequiredString(input.name, 'name');

    if (input.members !== undefined) {
      if (!Array.isArray(input.members))
        throw badRequest('members must be an array');

      output.members = uniqueMembers(await Promise.all(
        input.members.map((member) => this.normalizeMemberInput(member)),
      ));
    } else if (options.creating) {
      output.members = [];
    }

    return output;
  }

  async normalizeMemberInput(input = {}) {
    if (typeof input === 'string')
      return await this.resolveAgentMember(input);

    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw badRequest('team member must be an object or agent reference string');

    let type = normalizeOptionalString(input.type).toLowerCase();
    if (!type) {
      if (input.userID || input.email)
        type = 'user';
      else
        type = 'agent';
    }

    if (type === 'agent') {
      let reference = normalizeOptionalString(input.reference || input.agentReference || input.actorID || input.agentID || input.id || input.name);
      if (reference && this.agentManager?.resolveAgent)
        return await this.resolveAgentMember(reference);

      return {
        actorID: normalizeRequiredString(input.actorID || input.agentID || input.id, 'member.actorID'),
        type: 'agent',
        name: normalizeOptionalString(input.name) || normalizeOptionalString(input.actorID || input.agentID || input.id),
      };
    }

    if (type === 'user') {
      let actorID = normalizeRequiredString(input.actorID || input.userID || input.id || input.reference, 'member.actorID');
      return withoutEmptyStrings({
        actorID,
        type: 'user',
        name: normalizeOptionalString(input.name || input.displayName),
        username: normalizeOptionalString(input.username),
        fullName: normalizeOptionalString(input.fullName),
        email: normalizeOptionalString(input.email),
      });
    }

    throw badRequest('member.type must be agent or user');
  }

  async resolveAgentMember(reference) {
    if (!this.agentManager?.resolveAgent)
      return {
        actorID: normalizeRequiredString(reference, 'member.actorID'),
        type: 'agent',
        name: normalizeRequiredString(reference, 'member.name'),
      };

    let agent = await this.agentManager.resolveAgent(reference);
    if (!agent?.id)
      throw badRequest(`Agent not found: ${reference}`);

    return {
      actorID: agent.id,
      type: 'agent',
      name: agent.name || agent.id,
    };
  }
}

function uniqueMembers(members) {
  let output = [];
  let seen = new Set();
  for (let member of members || []) {
    let key = `${member.type}:${member.actorID}`;
    if (!member.actorID || seen.has(key))
      continue;

    seen.add(key);
    output.push(member);
  }
  return output;
}

function normalizeRequiredString(value, fieldName) {
  let normalized = normalizeOptionalString(value);
  if (!normalized)
    throw badRequest(`${fieldName} must be a non-empty string`);

  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function withoutEmptyStrings(value) {
  let output = {};
  for (let [key, item] of Object.entries(value)) {
    if (item !== '')
      output[key] = item;
  }
  return output;
}

function badRequest(message) {
  let error = new Error(message);
  error.status = 400;
  return error;
}
