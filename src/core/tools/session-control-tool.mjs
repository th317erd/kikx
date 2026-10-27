'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';
import { hasCoordinatorAuthority, resolveSessionCoordinator } from '../agents/coordinator-scope.mjs';
import { describeHaltResult, haltSessionTree } from '../agents/coordinator-tree-halt.mjs';
import { resolveSubtreeSessionIDs } from '../agents/session-subtree.mjs';

export class SessionControlTool extends PluginInterface {
  static pluginID = 'internal:session-control';
  static displayName = 'Session control';
  static description = 'Coordinator-only: inspect, resume, or suspend session agents.';
  static frameType = 'SessionControlToolFrame';
  static clientComponent = builtInToolComponent('kikx-agent-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [ 'list', 'resume', 'suspend' ],
        description: 'List suspension state, resume one agent, or suspend one agent.',
      },
      target: {
        type: 'string',
        description: 'Agent id or exact name for resume/suspend.',
      },
      sessionID: {
        type: 'string',
        description: 'Session to act on. Defaults to the calling agent\'s session. '
          + 'A coordinator may name its own session or any descendant of it; naming a '
          + 'parent or an unrelated session is refused.',
      },
      includeSubtree: {
        type: 'boolean',
        description: 'For suspend: also suspend every descendant session of sessionID. Defaults to true.',
      },
    },
    required: [ 'action' ],
    additionalProperties: false,
  };
  static help = 'Coordinator-only recovery tool. Use list to see suspended agents, then resume or suspend an agent by id/name. '
    + 'sessionID lets a coordinator reach its own session or a descendant (never an ancestor); includeSubtree fans a suspend out over the whole subtree. '
    + 'Commands are controlled with exec-list/exec-status/exec-resume/exec-kill.';

  async _execute(params = {}) {
    let frameRuntime = this.context.frameRuntime || this.context.services?.frameRuntime || resolveService(this.context, 'frameRuntime');
    let agentManager = this.context.agentManager || this.context.services?.agentManager || resolveService(this.context, 'agentManager');
    let processManager = this.context.processManager || this.context.services?.processManager || resolveService(this.context, 'processManager');
    let currentSessionID = this.context.session?.id;
    if (!frameRuntime || !currentSessionID)
      throw new Error('session-control requires an active session');

    let actorAgentID = this.context.agent?.id || null;
    let namedSessionID = typeof params.sessionID === 'string' ? params.sessionID.trim() : '';
    let sessionID = namedSessionID || currentSessionID;

    // One lookup. `getSession` is the runtime's cached read; the older
    // `requireSessionEntry` shape is still honoured so a caller (and the existing
    // specs) that predates this change keeps working.
    let getSession = (id) => frameRuntime.getSession?.(id)
      || frameRuntime.requireSessionEntry?.(id)?.session
      || null;

    // Subtree fan-out is opt-in for a caller that does not name a session, so an
    // unchanged call keeps the single-session behaviour it always had. Naming a
    // session explicitly is a deliberate act and defaults to the whole subtree.
    let includeSubtree = typeof params.includeSubtree === 'boolean'
      ? params.includeSubtree
      : namedSessionID !== '';

    // Authorisation is authority-over-the-target, not "is this my session".
    // A coordinator commands its own session and every descendant; naming a
    // parent, a sibling branch or an unrelated session is refused with a reason.
    let authority = hasCoordinatorAuthority({
      agentID: actorAgentID,
      targetSessionID: sessionID,
      getSession,
    });

    // The legacy self-check is kept as a floor so an agent that is somehow not
    // recorded as coordinator anywhere still cannot drive its own session through
    // this tool unless the context says it may.
    let selfCoordinator = this.context?.isCoordinator === true;

    if (!authority.allowed && !(selfCoordinator && sessionID === currentSessionID)) {
      throw new Error(buildAuthorityRefusal({
        actorAgentID,
        sessionID,
        currentSessionID,
        authority,
        getSession,
      }));
    }

    let action = String(params.action || '').trim().toLowerCase();

    if (action === 'list') {
      // F3: if a coordinator may halt a subtree it must also be able to see what
      // is running there, otherwise "stop" can report success over a live run.
      let includeSubtree = params.includeSubtree !== false;
      return await listAgents({
        frameRuntime,
        agentManager,
        sessionID,
        actorAgentID,
        includeSubtree,
        getSession,
      });
    }

    if (!selfCoordinator && authority.reason === 'not-coordinator') {
      throw new Error(buildAuthorityRefusal({
        actorAgentID,
        sessionID,
        currentSessionID,
        authority,
        getSession,
      }));
    }

    if (action === 'suspend') {
      let rawTarget = typeof params.target === 'string' ? params.target.trim() : '';

      // Own session, no subtree asked for: the pre-existing three-layer suspend,
      // unchanged, so its result shape and its runtime calls stay exactly as they
      // were. The tree-aware path below is for reaching another session or fanning
      // out, which are the new powers.
      if (sessionID === currentSessionID && includeSubtree !== true) {
        let agent = rawTarget ? await agentManager?.resolveAgent?.(rawTarget) : null;
        if (rawTarget && !agent)
          throw new Error(`session-control suspend found no agent matching ${rawTarget}`);
        if (agent) {
          frameRuntime.suspendAgent?.(sessionID, agent.id);
          frameRuntime.cancelAgentRuns?.(sessionID, agent.id);
          let suspendedCommandIDs = await processManager?.suspendSession?.(sessionID, { agentID: agent.id }) || [];
          await frameRuntime.persistSessionSuspension?.(sessionID);
          return {
            agentID: agent.id,
            agentName: agent.name || agent.id,
            suspended: true,
            suspendedCommandIDs,
            message: `${agent.name || agent.id} is suspended.`,
          };
        }
      }

      let result = await haltSessionTree({
        actorAgentID,
        targetSessionID: sessionID,
        currentSessionID,
        includeSubtree,
        target: rawTarget || null,
        reason: 'coordinator-halt',
        services: {
          frameRuntime,
          agentManager,
          processManager,
          listSessions: () => frameRuntime.listSessions?.({ limit: 500 }) || [],
        },
      });

      // The legacy flat fields are preserved for the own-session case so a caller
      // that reads `suspendedCommandIDs` or `suspended` does not have to change.
      let flatCommandIDs = (result.suspendedCommandIDs || [])
        .flatMap((entry) => entry.commandIDs || []);

      return {
        ...result,
        suspendedCommandIDs: flatCommandIDs,
        suspended: (result.cancelled || []).some((entry) => entry.agentIDs.length > 0),
        message: describeHaltResult(result),
      };
    }

    let target = typeof params.target === 'string' ? params.target.trim() : '';
    if (!target)
      throw new Error(`session-control ${action} requires a target agent`);
    if (!agentManager?.resolveAgent)
      throw new Error('session-control requires an agent manager');
    let agent = await agentManager.resolveAgent(target);

    if (action === 'resume') {
      let resumed = false;
      if (typeof frameRuntime.recordAgentResumes === 'function') {
        let frames = await frameRuntime.recordAgentResumes(sessionID, [ agent.id ], {
          reason: 'coordinator-resume',
          agentName: agent.name || agent.id,
          agentManager,
        });
        resumed = frames.length > 0;
      } else {
        resumed = frameRuntime.resumeAgent?.(sessionID, agent.id) === true;
      }
      return {
        agentID: agent.id,
        agentName: agent.name || agent.id,
        resumed,
        message: resumed
          ? `${agent.name || agent.id} is resumed. Any routed message can wake it with the suspension recovery warning.`
          : `${agent.name || agent.id} was not suspended.`,
      };
    }

    throw new Error(`Unknown session-control action: ${action}`);
  }
}

async function listAgents({
  frameRuntime,
  agentManager,
  sessionID,
  actorAgentID = null,
  includeSubtree = false,
  getSession = null,
}) {
  let lookup = typeof getSession === 'function'
    ? getSession
    : (id) => frameRuntime.getSession?.(id) || frameRuntime.requireSessionEntry?.(id)?.session || null;

  // Which sessions does this listing cover? Listing a descendant subtree without
  // the authority to halt it would be an information leak in the same shape as the
  // halt rule, so the set is filtered by the same predicate.
  let sessionIDs = [ sessionID ];
  if (includeSubtree) {
    let sessions = [];
    try {
      sessions = await frameRuntime.listSessions?.({ limit: 500 }) || [];
    } catch (_error) {
      sessions = [];
    }

    if (sessions.length > 0) {
      sessionIDs = resolveSubtreeSessionIDs(sessionID, { sessions }).sessionIDs;
    }
  }

  let reachable = actorAgentID
    ? sessionIDs.filter((candidateID) => hasCoordinatorAuthority({
      agentID: actorAgentID,
      targetSessionID: candidateID,
      getSession: lookup,
    }).allowed)
    : sessionIDs;

  let reported = [];
  for (let candidateID of reachable) {
    let suspend = frameRuntime.getSessionSuspension?.(candidateID);
    let session = lookup(candidateID);
    let participantAgentIDs = Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : [];
    let suspended = new Set(suspend?.suspendedAgentIDs || []);
    let active = new Set(frameRuntime.listActiveAgentRuns?.(candidateID) || []);
    let coordinatorAgentID = suspend?.coordinatorAgentID || session?.coordinatorAgentID || null;
    let agents = [];
    for (let agentID of participantAgentIDs) {
      let agent = null;
      try {
        agent = await agentManager?.getAgent?.(agentID) || null;
      } catch (_error) {}
      agents.push({
        agentID,
        name: agent?.name || agentID,
        coordinator: agentID === coordinatorAgentID,
        suspended: suspended.has(agentID),
        activeRun: active.has(agentID),
      });
    }
    reported.push({
      sessionID: candidateID,
      sessionSuspended: Boolean(suspend),
      restarted: suspend?.restarted === true,
      coordinatorAgentID,
      suspendedAgentIDs: [ ...suspended ],
      activeAgentIDs: [ ...active ],
      agents,
    });
  }

  let primary = reported[0] || {
    sessionID,
    sessionSuspended: false,
    restarted: false,
    coordinatorAgentID: null,
    suspendedAgentIDs: [],
    activeAgentIDs: [],
    agents: [],
  };

  return {
    // Flat fields keep the single-session shape that already existed, so nothing
    // reading this tool breaks.
    ...primary,
    sessions: reported,
    sessionIDs: reachable,
    refusedSessionIDs: sessionIDs.filter((candidateID) => !reachable.includes(candidateID)),
  };
}

/**
 * The refusal text for `session-control` when the actor lacks authority over the
 * named session. Names the reason and, where it can, who does hold authority, so
 * the agent can act instead of retrying blindly.
 */
function buildAuthorityRefusal({ actorAgentID, sessionID, currentSessionID, authority, getSession }) {
  let owner = resolveSessionCoordinator({ sessionID, getSession }).coordinatorAgentID;

  let why = authority.reason === 'not-coordinator'
    ? `${actorAgentID || 'this agent'} does not coordinate ${sessionID} or any of its ancestors`
    : `authority over ${sessionID} could not be established (${authority.reason})`;

  let hint = owner && owner !== actorAgentID
    ? ` Its coordinator is ${owner}.`
    : '';

  let text = `session-control refused for ${sessionID}: ${why}.${hint} `
    + `Coordinator authority flows down the session tree: you may act on ${currentSessionID} `
    + 'and its descendants, never on a parent or an unrelated branch.';

  // Keep the long-standing wording for the plainest case -- a caller acting on its
  // own session without being a coordinator anywhere -- because that is the message
  // the existing contract and its callers match on.
  if (sessionID === currentSessionID)
    text = `session-control is only available to the session coordinator. ${text}`;

  return text;
}

function resolveService(context = {}, name) {
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
