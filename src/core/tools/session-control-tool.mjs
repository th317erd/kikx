'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

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
    },
    required: [ 'action' ],
    additionalProperties: false,
  };
  static help = 'Coordinator-only recovery tool. Use list to see suspended agents, then resume or suspend an agent by id/name. Commands are controlled with exec-list/exec-status/exec-resume/exec-kill.';

  async _execute(params = {}) {
    if (this.context?.isCoordinator !== true)
      throw new Error('session-control is only available to the session coordinator');

    let frameRuntime = this.context.frameRuntime || this.context.services?.frameRuntime || resolveService(this.context, 'frameRuntime');
    let agentManager = this.context.agentManager || this.context.services?.agentManager || resolveService(this.context, 'agentManager');
    let processManager = this.context.processManager || this.context.services?.processManager || resolveService(this.context, 'processManager');
    let sessionID = this.context.session?.id;
    if (!frameRuntime || !sessionID)
      throw new Error('session-control requires an active session');

    let action = String(params.action || '').trim().toLowerCase();
    if (action === 'list')
      return await listAgents({ frameRuntime, agentManager, sessionID });

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

    if (action === 'suspend') {
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

    throw new Error(`Unknown session-control action: ${action}`);
  }
}

async function listAgents({ frameRuntime, agentManager, sessionID }) {
  let suspend = frameRuntime.getSessionSuspension?.(sessionID);
  let session = frameRuntime.requireSessionEntry?.(sessionID)?.session || null;
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
    sessionSuspended: Boolean(suspend),
    restarted: suspend?.restarted === true,
    coordinatorAgentID,
    suspendedAgentIDs: [ ...suspended ],
    activeAgentIDs: [ ...active ],
    agents,
  };
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
