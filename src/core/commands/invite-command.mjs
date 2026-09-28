'use strict';

export class InviteCommand {
  static description = 'Invite an actor or team into the current session.';

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ args, frame, services }) {
    let target = normalizeInviteReference(args);
    let agentManager = resolveService(services, 'agentManager');
    let teamManager = resolveService(services, 'teamManager');
    let frameRuntime = resolveService(services, 'frameRuntime');

    if (!agentManager)
      throw new Error('/invite requires an agent manager');

    if (!frameRuntime)
      throw new Error('/invite requires a frame runtime');

    if (target.type === 'agent') {
      let agent = await agentManager.resolveAgent(target.reference);
      return await this.inviteAgent({ agent, frame, services, frameRuntime });
    }

    if (target.type === 'team') {
      if (!teamManager)
        throw new Error('/invite team requires a team manager');

      let team = await teamManager.resolveTeam(target.reference);
      return await this.inviteTeam({ team, frame, services, frameRuntime, agentManager });
    }

    let [agentResult, teamResult] = await Promise.all([
      settleNotFound(() => agentManager.resolveAgent(target.reference)),
      teamManager ? settleNotFound(() => teamManager.resolveTeam(target.reference)) : Promise.resolve(null),
    ]);

    if (agentResult?.error)
      throw agentResult.error;

    if (teamResult?.error)
      throw teamResult.error;

    if (agentResult?.value && teamResult?.value) {
      let error = new Error(`Ambiguous invite target: ${target.reference}. Use agent:${target.reference} or team:${target.reference}.`);
      error.status = 400;
      throw error;
    }

    if (teamResult?.value)
      return await this.inviteTeam({ team: teamResult.value, frame, services, frameRuntime, agentManager });

    if (!agentResult?.value) {
      let error = new Error(`Invite target not found: ${target.reference}`);
      error.status = 404;
      throw error;
    }

    return await this.inviteAgent({ agent: agentResult.value, frame, services, frameRuntime });
  }

  async inviteAgent({ agent, frame, services, frameRuntime }) {
    let result = await frameRuntime.inviteAgentToSession(frame.sessionID, agent, {
      invitedByUserID: frame.authorID || null,
      invitedAt: frame.timestamp || frame.createdAt || services?.clock?.() || Date.now(),
    });

    return {
      status: result.alreadyParticipant ? 'ok' : 'ok',
      message: result.alreadyParticipant
        ? `${agent.name} is already in this session.`
        : `${agent.name} joined this session.`,
      data: {
        agentID: agent.id,
        agentName: agent.name,
        alreadyParticipant: result.alreadyParticipant,
      },
    };
  }

  async inviteTeam({ team, frame, services, frameRuntime, agentManager }) {
    let invitedAgents = [];
    let invitedUsers = [];
    let alreadyParticipants = [];
    let session = null;
    let members = Array.isArray(team.members) ? team.members : [];

    for (let member of members) {
      if (member?.type === 'agent') {
        let agent = await resolveAgentByID(agentManager, member.actorID);
        let result = await frameRuntime.inviteAgentToSession(frame.sessionID, agent, {
          invitedByUserID: frame.authorID || null,
          invitedAt: frame.timestamp || frame.createdAt || services?.clock?.() || Date.now(),
        });
        session = result.session;
        let entry = {
          actorID: agent.id,
          type: 'agent',
          name: agent.name || member.name || agent.id,
        };
        if (result.alreadyParticipant)
          alreadyParticipants.push(entry);
        else
          invitedAgents.push(entry);
        continue;
      }

      if (member?.type === 'user') {
        if (typeof frameRuntime.inviteUserToSession !== 'function')
          throw new Error('/invite team requires frameRuntime.inviteUserToSession() for user members');

        let result = await frameRuntime.inviteUserToSession(frame.sessionID, {
          id: member.actorID,
          ...member,
        }, {
          invitedByUserID: frame.authorID || null,
          invitedAt: frame.timestamp || frame.createdAt || services?.clock?.() || Date.now(),
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

    let invitedCount = invitedAgents.length + invitedUsers.length;
    let alreadyCount = alreadyParticipants.length;
    let message;
    if (members.length === 0)
      message = `Team ${team.name} has no members.`;
    else if (invitedCount === 0)
      message = `Team ${team.name} is already in this session.`;
    else
      message = `Team ${team.name} joined this session (${formatInviteCounts(invitedAgents.length, invitedUsers.length)}).`;

    return {
      status: 'ok',
      message,
      data: {
        teamID: team.id,
        teamName: team.name,
        invitedCount,
        alreadyParticipantCount: alreadyCount,
        invitedAgents,
        invitedUsers,
        alreadyParticipants,
        sessionID: session?.id || frame.sessionID,
      },
    };
  }
}

function normalizeInviteReference(args) {
  if (typeof args !== 'string' || args.trim() === '')
    throw new Error('Usage: /invite actor-or-team-name');

  let reference = unquoteReference(args.trim());
  let match = reference.match(/^(agent|team):([\s\S]*)$/i);
  if (match) {
    let value = unquoteReference(match[2].trim());
    if (!value)
      throw new Error(`Usage: /invite ${match[1].toLowerCase()}:name`);

    return {
      type: match[1].toLowerCase(),
      reference: value,
    };
  }

  return {
    type: '',
    reference,
  };
}

function unquoteReference(reference) {
  let quote = reference[0];
  if ((quote === '"' || quote === "'") && reference.at(-1) === quote)
    return unescapeQuotedReference(reference.slice(1, -1), quote);

  if (quote === '"' || quote === "'")
    throw new Error('Usage: /invite "actor or team name"');

  return reference;
}

function unescapeQuotedReference(value, quote) {
  return value.replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\').trim();
}

async function settleNotFound(callback) {
  try {
    return { value: await callback() };
  } catch (error) {
    if (error?.status === 404)
      return null;

    return { error };
  }
}

function formatInviteCounts(agentCount, userCount) {
  let parts = [];
  if (agentCount > 0)
    parts.push(`${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`);

  if (userCount > 0)
    parts.push(`${userCount} ${userCount === 1 ? 'user' : 'users'}`);

  return parts.join(', ') || '0 actors';
}

async function resolveAgentByID(agentManager, agentID) {
  if (typeof agentManager.getAgent === 'function')
    return await agentManager.getAgent(agentID);

  if (typeof agentManager.resolveAgent === 'function')
    return await agentManager.resolveAgent(agentID);

  throw new Error('/invite team requires agentManager.getAgent() or resolveAgent()');
}

function resolveService(services, name) {
  if (services?.[name])
    return services[name];

  if (services?.context?.has?.(name) && typeof services.context.require === 'function')
    return services.context.require(name);

  if (typeof services?.context?.require === 'function') {
    try {
      return services.context.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
