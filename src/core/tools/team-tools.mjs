'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

const DEFAULT_TEAM_LIST_LIMIT = 50;
const MAX_TEAM_LIST_LIMIT = 200;
const TEAM_MEMBER_ITEM_SCHEMA = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [ 'agent', 'user' ] },
        reference: { type: 'string' },
        actorID: { type: 'string' },
        agentID: { type: 'string' },
        userID: { type: 'string' },
        name: { type: 'string' },
        username: { type: 'string' },
        fullName: { type: 'string' },
        email: { type: 'string' },
      },
      additionalProperties: false,
    },
  ],
};

class TeamTool extends PluginInterface {
  static pluginID = 'internal:teams';
  static clientComponent = builtInToolComponent('kikx-team-tool-use');
  static riskLevel = 'none';

  teamManager() {
    let teamManager = this.context.teamManager || this.context.services?.teamManager || resolveContextService(this.context, 'teamManager');
    if (!teamManager)
      throw new Error(`${this.constructor.featureName} requires teamManager`);

    return teamManager;
  }

  agentManager() {
    let agentManager = this.context.agentManager || this.context.services?.agentManager || resolveContextService(this.context, 'agentManager');
    if (!agentManager)
      throw new Error(`${this.constructor.featureName} requires agentManager`);

    return agentManager;
  }

  frameRuntime() {
    let runtime = this.context.frameRuntime || this.context.services?.frameRuntime || resolveContextService(this.context, 'frameRuntime');
    if (!runtime)
      throw new Error(`${this.constructor.featureName} requires frameRuntime`);

    return runtime;
  }

  targetSessionID(params = {}) {
    return normalizeOptionalString(params._sessionID || params.session_id || params.sessionID || this.context.session?.id);
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
}

export class TeamListTool extends TeamTool {
  static featureName = 'team-list';
  static displayName = 'List teams';
  static description = 'List Kikx teams. Teams are collections of actor members, including agents and real users.';
  static frameType = 'TeamListToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TEAM_LIST_LIMIT,
        description: 'Maximum number of teams to return.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Team list offset.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use team-list to discover team IDs, names, and actor members before inviting a whole team.';

  async _execute(params = {}) {
    let limit = clampInteger(params.limit, DEFAULT_TEAM_LIST_LIMIT, 1, MAX_TEAM_LIST_LIMIT);
    let offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let teams = await this.teamManager().listTeams({ limit, offset });
    return {
      teams: teams.map((team) => sanitizeTeam(team)),
      count: teams.length,
      limit,
      offset,
    };
  }
}

export class TeamCreateTool extends TeamTool {
  static featureName = 'team-create';
  static displayName = 'Create team';
  static description = 'Create a Kikx team of actor members. Creating or deleting a team never deletes the actors in it.';
  static frameType = 'TeamCreateToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Team name.',
      },
      members: {
        type: 'array',
        items: TEAM_MEMBER_ITEM_SCHEMA,
        description: 'Optional actor members. String entries resolve as agent IDs or exact agent names.',
      },
    },
    required: [ 'name' ],
    additionalProperties: false,
  };
  static help = 'Use team-create to group agents and users into a reusable team. String members are agent references; user members should include type:"user" and an actorID/userID.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('team-create');
    let team = await this.teamManager().createTeam({
      name: normalizeRequiredString(params.name, 'name'),
      members: Array.isArray(params.members) ? params.members : [],
    });
    return {
      team: sanitizeTeam(team),
      created: true,
    };
  }
}

export class TeamUpdateTool extends TeamTool {
  static featureName = 'team-update';
  static displayName = 'Update team';
  static description = 'Rename a team or replace its full member list.';
  static frameType = 'TeamUpdateToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      team: {
        type: 'string',
        description: 'Team ID or exact team name.',
      },
      name: {
        type: 'string',
        description: 'New team name.',
      },
      members: {
        type: 'array',
        items: TEAM_MEMBER_ITEM_SCHEMA,
        description: 'Replacement actor member list. Omit to keep existing members.',
      },
    },
    required: [ 'team' ],
    additionalProperties: false,
  };
  static help = 'Use team-update to rename a team or replace the whole member list. For small edits, prefer team-add-member or team-remove-member.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('team-update');
    let existing = await this.teamManager().resolveTeam(normalizeRequiredString(params.team, 'team'));
    let patch = {};
    if (params.name !== undefined)
      patch.name = normalizeRequiredString(params.name, 'name');
    if (params.members !== undefined)
      patch.members = params.members;

    let team = await this.teamManager().updateTeam(existing.id, patch);
    return {
      team: sanitizeTeam(team),
      updated: true,
    };
  }
}

export class TeamDeleteTool extends TeamTool {
  static featureName = 'team-delete';
  static displayName = 'Delete team';
  static description = 'Delete a Kikx team without deleting any actors in that team.';
  static frameType = 'TeamDeleteToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      team: {
        type: 'string',
        description: 'Team ID or exact team name.',
      },
    },
    required: [ 'team' ],
    additionalProperties: false,
  };
  static help = 'Use team-delete to delete only the team collection. It does not delete agents or users.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('team-delete');
    let team = await this.teamManager().resolveTeam(normalizeRequiredString(params.team, 'team'));
    await this.teamManager().deleteTeam(team.id);
    return {
      teamID: team.id,
      teamName: team.name,
      deleted: true,
    };
  }
}

export class TeamAddMemberTool extends TeamTool {
  static featureName = 'team-add-member';
  static displayName = 'Add team member';
  static description = 'Add an actor member to a Kikx team.';
  static frameType = 'TeamAddMemberToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      team: {
        type: 'string',
        description: 'Team ID or exact team name.',
      },
      member: {
        ...TEAM_MEMBER_ITEM_SCHEMA,
        description: 'Actor member. String values resolve as agent IDs or exact agent names.',
      },
    },
    required: [ 'team', 'member' ],
    additionalProperties: false,
  };
  static help = 'Use team-add-member to add an agent or user actor to an existing team.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('team-add-member');
    let team = await this.teamManager().resolveTeam(normalizeRequiredString(params.team, 'team'));
    let updated = await this.teamManager().addMember(team.id, params.member);
    return {
      team: sanitizeTeam(updated),
      updated: true,
    };
  }
}

export class TeamRemoveMemberTool extends TeamTool {
  static featureName = 'team-remove-member';
  static displayName = 'Remove team member';
  static description = 'Remove an actor member from a Kikx team without deleting the actor.';
  static frameType = 'TeamRemoveMemberToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      team: {
        type: 'string',
        description: 'Team ID or exact team name.',
      },
      actorID: {
        type: 'string',
        description: 'Actor ID to remove.',
      },
      type: {
        type: 'string',
        enum: [ 'agent', 'user' ],
        description: 'Optional actor type disambiguator.',
      },
    },
    required: [ 'team', 'actorID' ],
    additionalProperties: false,
  };
  static help = 'Use team-remove-member to remove one actor from a team. This never deletes the actor itself.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('team-remove-member');
    let team = await this.teamManager().resolveTeam(normalizeRequiredString(params.team, 'team'));
    let updated = await this.teamManager().removeMember(team.id, {
      actorID: normalizeRequiredString(params.actorID, 'actorID'),
      type: normalizeOptionalString(params.type),
    });
    return {
      team: sanitizeTeam(updated),
      updated: true,
    };
  }
}

export class SessionInviteTeamTool extends TeamTool {
  static featureName = 'session-invite-team';
  static displayName = 'Invite team';
  static description = 'Invite every actor member of a team into the current or target Kikx session.';
  static frameType = 'SessionInviteTeamToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      team: {
        type: 'string',
        description: 'Team ID or exact team name to invite.',
      },
    },
    required: [ 'team' ],
    additionalProperties: false,
  };
  static help = 'Use session-invite-team with session_id to invite all team members into a target session. Agent members become participant agents; user members become participant users.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('session-invite-team');

    let sessionID = requireTargetSessionID(this.targetSessionID(params));
    let team = await this.teamManager().resolveTeam(normalizeRequiredString(params.team, 'team'));
    let runtime = this.frameRuntime();
    let invitedAgents = [];
    let invitedUsers = [];
    let alreadyParticipants = [];
    let session = null;

    for (let member of team.members || []) {
      if (member.type === 'agent') {
        let agent = await resolveAgentByID(this.agentManager(), member.actorID);
        let result = await runtime.inviteAgentToSession(sessionID, agent, {
          invitedByAgentID: this.context.agent?.id || null,
        });
        session = result.session;
        let entry = { actorID: agent.id, type: 'agent', name: agent.name || member.name || agent.id };
        if (result.alreadyParticipant)
          alreadyParticipants.push(entry);
        else
          invitedAgents.push(entry);
        continue;
      }

      if (member.type === 'user') {
        if (typeof runtime.inviteUserToSession !== 'function')
          throw new Error('session-invite-team requires frameRuntime.inviteUserToSession() for user members');

        let result = await runtime.inviteUserToSession(sessionID, { id: member.actorID, ...member }, {
          invitedByAgentID: this.context.agent?.id || null,
        });
        session = result.session;
        let entry = {
          actorID: result.userID,
          type: 'user',
          name: member.name || member.username || member.fullName || result.userID,
        };
        if (result.alreadyParticipant)
          alreadyParticipants.push(entry);
        else
          invitedUsers.push(entry);
      }
    }

    return {
      sessionID,
      session: sanitizeSession(session || (await runtime.ensureSessionEntry(sessionID, { loadFrames: false })).session),
      team: sanitizeTeam(team),
      invitedAgents,
      invitedUsers,
      alreadyParticipants,
      invitedCount: invitedAgents.length + invitedUsers.length,
    };
  }
}

function sanitizeTeam(team = {}) {
  return {
    id: team.id || null,
    name: team.name || team.id || '',
    members: Array.isArray(team.members) ? team.members.map((member) => ({ ...member })) : [],
    createdAt: team.createdAt || null,
    updatedAt: team.updatedAt || null,
  };
}

function sanitizeSession(session = {}) {
  return {
    id: session.id || null,
    title: session.title || session.id || '',
    participantAgentIDs: normalizeStringArray(session.participantAgentIDs),
    participantUserIDs: normalizeStringArray(session.participantUserIDs),
    coordinatorAgentID: session.coordinatorAgentID || null,
    messageCount: normalizeNonNegativeInteger(session.messageCount, 0),
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
  };
}

function requireTargetSessionID(sessionID) {
  let normalized = normalizeOptionalString(sessionID);
  if (!normalized)
    throw new TypeError('session_id is required when no current session is available');

  return normalized;
}

async function resolveAgentByID(agentManager, agentID) {
  if (typeof agentManager.getAgent === 'function')
    return await agentManager.getAgent(agentID);

  if (typeof agentManager.resolveAgent === 'function')
    return await agentManager.resolveAgent(agentID);

  throw new Error('agent resolution requires agentManager.getAgent() or resolveAgent()');
}

function resolveContextService(context, name) {
  if (context?.services?.context?.has?.(name) && typeof context.services.context.require === 'function')
    return context.services.context.require(name);

  if (typeof context?.services?.context?.require === 'function') {
    try {
      return context.services.context.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
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

function normalizeNonNegativeInteger(value, fallback) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;

  return Math.trunc(number);
}

function sessionGeneration(session) {
  if (!session || typeof session !== 'object')
    return 0;

  let number = Number(session.generation);
  if (Number.isFinite(number) && number >= 0)
    return Math.trunc(number);

  return session.parentSessionID ? 1 : 0;
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    return defaultValue;

  return Math.max(min, Math.min(Math.trunc(number), max));
}
