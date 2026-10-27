'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';
import { hasCoordinatorAuthority, resolveSessionCoordinator } from '../agents/coordinator-scope.mjs';
import { describeHaltResult, haltSessionTree } from '../agents/coordinator-tree-halt.mjs';
import { resolveSubtreeSessionIDs } from '../agents/session-subtree.mjs';
import { normalizeOptionalString } from './session-tool-helpers.mjs';

export class SessionControlTool extends PluginInterface {
  static pluginID = 'internal:session-control';
  static displayName = 'Session control';
  static description = 'Coordinator-only: inspect, resume, suspend, kick, or soft-delete session agents/sessions.';
  static frameType = 'SessionControlToolFrame';
  static clientComponent = builtInToolComponent('kikx-agent-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [ 'list', 'resume', 'suspend', 'kick', 'delete' ],
        description: 'List state, resume/suspend one agent, remove a participant, or soft-delete a descendant session.',
      },
      target: {
        type: 'string',
        description: 'Agent id or exact name for resume/suspend.',
      },
      session_id: {
        type: 'string',
        minLength: 1,
        description: 'Target session ID. Defaults to the current session. '
          + 'A coordinator may name its own session or any descendant of it; naming a '
          + 'parent or an unrelated session is refused.',
      },
      includeSubtree: {
        type: 'boolean',
        description: 'For suspend: also suspend every descendant session of session_id. Defaults to true.',
      },
    },
    required: [ 'action' ],
    additionalProperties: false,
  };
  static help = 'Coordinator-only session control. Use list to see suspended agents, resume or suspend an agent by id/name, kick an agent out of a session, or soft-delete a descendant session. '
    + 'Pass session_id to reach the current session or any descendant of it (never a parent or an unrelated branch); includeSubtree fans a suspend out over that subtree. '
    + 'Kick removes the participant, cancels its runs, and promotes a remaining coordinator if needed; the last participant cannot be removed. '
    + 'Delete is a soft delete: it stamps deletedAt on a descendant session and hides it from the normal session list, but frames remain recoverable. It refuses the current session, any session with active agent runs, and any session with a live command. '
    + 'Suspension cancels queued work and freezes running commands at the next yield, but cannot preempt a provider call that is already blocked. '
    + 'Commands are controlled with exec-list/exec-status/exec-resume/exec-kill.';

  async _execute(params = {}) {
    let frameRuntime = this.context.frameRuntime || this.context.services?.frameRuntime || resolveService(this.context, 'frameRuntime');
    let agentManager = this.context.agentManager || this.context.services?.agentManager || resolveService(this.context, 'agentManager');
    let processManager = this.context.processManager || this.context.services?.processManager || resolveService(this.context, 'processManager');
    let currentSessionID = this.context.session?.id;
    let namedSessionID = normalizeOptionalString(params.session_id || params.sessionID);
    let sessionID = namedSessionID || currentSessionID;
    if (!frameRuntime || !currentSessionID || !sessionID)
      throw new Error('session-control requires an active session');

    // One lookup. `getSession` is the runtime's cached read; the older
    // `requireSessionEntry` shape is still honoured so a caller (and the existing
    // specs) that predates this change keeps working.
    let getSession = (id) => frameRuntime.getSession?.(id)
      || frameRuntime.requireSessionEntry?.(id)?.session
      || null;

    let actorAgentID = this.context.agent?.id || null;
    let selfCoordinator = this.context?.isCoordinator === true;
    // The tool context does not always name the acting agent (a boot-time context
    // and most fixtures carry only `isCoordinator`). Since `isCoordinator` already
    // asserts that the caller IS this session's coordinator, the session's own
    // recorded coordinator is the honest identity for the authority walk. Without
    // this fallback the halt path refused its own coordinator and returned an
    // empty, successful-looking result.
    let actingAgentID = this.context.agent?.id || null;
    if (!actingAgentID && selfCoordinator) {
      actingAgentID = getSession(currentSessionID)?.coordinatorAgentID || null;
      if (!actingAgentID && typeof frameRuntime.ensureSessionEntry === 'function') {
        try {
          let own = await frameRuntime.ensureSessionEntry(currentSessionID, { loadFrames: false });
          actingAgentID = own?.session?.coordinatorAgentID || null;
        } catch (_error) {
          actingAgentID = null;
        }
      }
    }

    // Hydrate the target and check it is on this coordinator's own branch, so the
    // participant list and title below are readable even after the session was
    // evicted from the runtime cache.
    let sessionEntry;
    try {
      sessionEntry = await resolveControlledSession({
        frameRuntime,
        sourceSessionID: currentSessionID,
        targetSessionID: sessionID,
      });
    } catch (ancestryError) {
      // An ancestor or an unrelated branch. Both rules agree on the REFUSAL --
      // authority flows down the tree, never up -- but the terse ancestry text
      // does not say who DOES hold authority, which is the actionable half.
      // Re-throw through the authority refusal, then restate the canonical rule
      // so every caller (old wording and new) matches one message.
      let refusalAuthority = hasCoordinatorAuthority({
        agentID: this.context.agent?.id || null,
        targetSessionID: sessionID,
        getSession,
      });
      let detail = buildAuthorityRefusal({
        actorAgentID: this.context.agent?.id || null,
        sessionID,
        currentSessionID,
        authority: refusalAuthority,
        getSession,
      });
      throw new Error(detail
        + ' session-control may only target the current session or one of its descendants.');
    }
    let session = sessionEntry?.session || getSession(sessionID) || null;

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
      agentID: actingAgentID,
      targetSessionID: sessionID,
      getSession,
    });

    // The legacy self-check is kept as a floor so an agent that is somehow not
    // recorded as coordinator anywhere still cannot drive its own session through
    // this tool unless the context says it may. (`selfCoordinator` is computed
    // above, next to `actingAgentID`.)

    if (!authority.allowed && !selfCoordinator) {
      throw new Error(buildAuthorityRefusal({
        actorAgentID,
        sessionID,
        currentSessionID,
        authority,
        getSession,
      }));
    }

    let action = String(params.action || '').trim().toLowerCase();

    if (action === 'delete') {
      if (sessionID === currentSessionID)
        throw new Error('session-control delete refuses to delete the current session; name a descendant session');
      if (params.includeSubtree === true)
        throw new Error('session-control delete is single-session only; it will not delete a subtree');
      if (typeof frameRuntime.deleteSession !== 'function')
        throw new Error('session-control delete requires frameRuntime.deleteSession');
      if (session?.deletedAt)
        return {
          sessionID,
          sessionTitle: session.title || sessionID,
          deleted: false,
          alreadyDeleted: true,
          deletedAt: session.deletedAt,
          message: `${session.title || sessionID} is already soft-deleted.`,
        };

      let activeAgentIDs = frameRuntime.listActiveAgentRuns?.(sessionID) || [];
      if (activeAgentIDs.length > 0) {
        throw new Error(
          `Refusing to delete ${session?.title || sessionID}: ${activeAgentIDs.length} agent run(s) are still active. `
          + 'Suspend or cancel them first.',
        );
      }

      let liveProcesses = processManager?.listProcesses?.({
        _sessionID: sessionID,
        _isCoordinator: selfCoordinator,
        includeCompleted: false,
        limit: 1,
      })?.processes || [];
      if (liveProcesses.length > 0)
        throw new Error(`Refusing to delete ${session?.title || sessionID}: it still has a live command. Suspend or kill it first.`);

      let deleted = await frameRuntime.deleteSession(sessionID);
      return {
        sessionID,
        sessionTitle: deleted.title || session?.title || sessionID,
        deleted: true,
        alreadyDeleted: false,
        deletedAt: deleted.deletedAt,
        message: `${deleted.title || sessionID} was soft-deleted. Its frames remain recoverable.`,
      };
    }

    if (action === 'list') {
      // F3: if a coordinator may halt a subtree it must also be able to see what
      // is running there, otherwise "stop" can report success over a live run.
      return await listAgents({
        frameRuntime,
        agentManager,
        sessionID,
        session,
        actorAgentID,
        includeSubtree: params.includeSubtree !== false,
        getSession,
      });
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
            sessionID,
            sessionTitle: session?.title || sessionID,
            agentID: agent.id,
            agentName: agent.name || agent.id,
            suspended: true,
            suspendedCommandIDs,
            message: `${agent.name || agent.id} is suspended in ${session?.title || sessionID}.`,
          };
        }
      }

      let result = await haltSessionTree({
        actorAgentID: actingAgentID,
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

      // One contract: `suspendedCommandIDs` is a flat list of command ids, exactly
      // as the single-session path already returns. The per-session breakdown stays
      // on `result.sessions[]`, so flattening here loses nothing.
      let commandEntries = (result.suspendedCommandIDs || []).map((entry) => ({
        sessionID: entry?.sessionID || sessionID,
        commandIDs: Array.isArray(entry?.commandIDs) ? entry.commandIDs : [],
      }));
      let flatCommandIDs = commandEntries.flatMap((entry) => entry.commandIDs);

      return {
        ...result,
        sessionID,
        sessionTitle: session?.title || sessionID,
        sessions: (result.cancelled || []).map((entry, index) => ({
          sessionID: entry?.sessionID || sessionID,
          cancelledAgentIDs: entry?.agentIDs || [],
          suspendedCommandIDs: commandEntries[index]?.commandIDs || [],
        })),
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
    let participantAgentIDs = Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : [];
    if (!participantAgentIDs.includes(agent.id))
      throw new Error(`${agent.name || agent.id} is not a participant in ${session?.title || sessionID}`);

    if (action === 'kick') {
      frameRuntime.cancelAgentRuns?.(sessionID, agent.id);
      let suspendedCommandIDs = await processManager?.suspendSession?.(sessionID, { agentID: agent.id }) || [];
      let removed = await frameRuntime.removeAgentFromSession(sessionID, agent.id, {
        removedByAgentID: this.context.agent?.id || null,
        removedAgentName: agent.name || agent.id,
        frameID: this.context.frame?.id || null,
        interactionID: this.context.frame?.interactionID || null,
      });
      return {
        sessionID,
        sessionTitle: removed.session.title || sessionID,
        agentID: agent.id,
        agentName: agent.name || agent.id,
        removed: true,
        coordinatorAgentID: removed.coordinatorAgentID,
        suspendedCommandIDs,
        auditFrameID: removed.auditFrame?.id || null,
        message: `${agent.name || agent.id} was removed from ${removed.session.title || sessionID}.`,
      };
    }

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
        sessionID,
        sessionTitle: session?.title || sessionID,
        agentID: agent.id,
        agentName: agent.name || agent.id,
        resumed,
        message: resumed
          ? `${agent.name || agent.id} is resumed in ${session?.title || sessionID}. Any routed message can wake it with the suspension recovery warning.`
          : `${agent.name || agent.id} was not suspended in ${session?.title || sessionID}.`,
      };
    }

    throw new Error(`Unknown session-control action: ${action}`);
  }
}

async function listAgents({
  frameRuntime,
  agentManager,
  sessionID,
  session = null,
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
    let targetSession = candidateID === sessionID && session ? session : lookup(candidateID);
    let participantAgentIDs = Array.isArray(targetSession?.participantAgentIDs) ? targetSession.participantAgentIDs : [];
    let suspended = new Set(suspend?.suspendedAgentIDs || []);
    let active = new Set(frameRuntime.listActiveAgentRuns?.(candidateID) || []);
    let coordinatorAgentID = suspend?.coordinatorAgentID || targetSession?.coordinatorAgentID || null;
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
    sessionTitle: session?.title || sessionID,
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

async function resolveControlledSession({ frameRuntime, sourceSessionID, targetSessionID }) {
  let entry = await frameRuntime.ensureSessionEntry(targetSessionID, { loadFrames: false });
  if (entry?.framesLoaded !== true && typeof frameRuntime.hydrateSessionSuspension === 'function')
    await frameRuntime.hydrateSessionSuspension(entry, []);
  if (targetSessionID === sourceSessionID)
    return entry;

  let seen = new Set();
  let cursor = normalizeOptionalString(entry?.session?.parentSessionID);
  while (cursor && !seen.has(cursor)) {
    if (cursor === sourceSessionID)
      return entry;

    seen.add(cursor);
    let parent = await frameRuntime.ensureSessionEntry(cursor, { loadFrames: false });
    cursor = normalizeOptionalString(parent?.session?.parentSessionID);
  }

  throw new Error('session-control may only target the current session or one of its descendants');
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
