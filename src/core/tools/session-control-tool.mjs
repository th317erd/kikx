'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';
import { normalizeOptionalString } from './session-tool-helpers.mjs';

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
      session_id: {
        type: 'string',
        minLength: 1,
        description: 'Target session ID. Defaults to the current session. Cross-session control is limited to the current session and its descendants.',
      },
    },
    required: [ 'action' ],
    additionalProperties: false,
  };
  static help = 'Coordinator-only recovery tool. Use list to see suspended agents, then resume or suspend an agent by id/name. Pass session_id to inspect or control a descendant session; the current session is the default. Suspension cancels queued work and freezes running commands at the next yield, but cannot preempt a provider call that is already blocked. Commands are controlled with exec-list/exec-status/exec-resume/exec-kill.';

  async _execute(params = {}) {
    if (this.context?.isCoordinator !== true)
      throw new Error('session-control is only available to the session coordinator');

    let frameRuntime = this.context.frameRuntime || this.context.services?.frameRuntime || resolveService(this.context, 'frameRuntime');
    let agentManager = this.context.agentManager || this.context.services?.agentManager || resolveService(this.context, 'agentManager');
    let processManager = this.context.processManager || this.context.services?.processManager || resolveService(this.context, 'processManager');
    let sourceSessionID = this.context.session?.id;
    let sessionID = normalizeOptionalString(params.session_id || params.sessionID || sourceSessionID);
    if (!frameRuntime || !sourceSessionID || !sessionID)
      throw new Error('session-control requires an active session');

    let sessionEntry = await resolveControlledSession({
      frameRuntime,
      sourceSessionID,
      targetSessionID: sessionID,
    });
    let session = sessionEntry.session;

    let action = String(params.action || '').trim().toLowerCase();
    if (action === 'list')
      return await listAgents({ frameRuntime, agentManager, sessionID, session });

    let target = typeof params.target === 'string' ? params.target.trim() : '';
    if (!target)
      throw new Error(`session-control ${action} requires a target agent`);
    if (!agentManager?.resolveAgent)
      throw new Error('session-control requires an agent manager');
    let agent = await agentManager.resolveAgent(target);
    let participantAgentIDs = Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : [];
    if (!participantAgentIDs.includes(agent.id))
      throw new Error(`${agent.name || agent.id} is not a participant in ${session?.title || sessionID}`);

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

    if (action === 'suspend') {
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
        message: `${agent.name || agent.id} is suspended in ${session?.title || sessionID}. Future tool calls are frozen and queued work is cancelled; a provider call already in progress can only stop at its next yield.`,
      };
    }

    throw new Error(`Unknown session-control action: ${action}`);
  }
}

async function listAgents({ frameRuntime, agentManager, sessionID, session }) {
  let suspend = frameRuntime.getSessionSuspension?.(sessionID);
  session ||= (await frameRuntime.ensureSessionEntry?.(sessionID, { loadFrames: false }))?.session || null;
  let participantAgentIDs = Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : [];
  let suspended = new Set(suspend?.suspendedAgentIDs || []);
  let active = new Set(frameRuntime.listActiveAgentRuns?.(sessionID) || []);
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
  return {
    sessionID,
    sessionTitle: session?.title || sessionID,
    sessionSuspended: Boolean(suspend),
    restarted: suspend?.restarted === true,
    coordinatorAgentID,
    suspendedAgentIDs: [ ...suspended ],
    activeAgentIDs: [ ...active ],
    agents,
  };
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
