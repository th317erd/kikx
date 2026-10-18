'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { parseMentionReferences, resolveMentionActors } from '../mentions/index.mjs';
import { createLocatorSearchRequest, formatSearchResponse } from './database-tools.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';
import { wakeInvitedAgent } from './session-invite-wake.mjs';

import {
  clampInteger,
  findReusableChildSession,
  frameReferenceFromPath,
  normalizeNonNegativeInteger,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeStringArray,
  postAgentSessionMessage,
  requireTargetSessionID,
  resolveAgents,
  resolveContextService,
  sanitizeAgent,
  sanitizeFrame,
  sanitizeSession,
  sessionFrameSearchPath,
  sessionGeneration,
  summarizeFrameContent,
  uniqueStrings,
} from './session-tool-helpers.mjs';

const DEFAULT_SESSION_LIST_LIMIT = 20;
const MAX_SESSION_LIST_LIMIT = 100;
const DEFAULT_FRAME_LIST_LIMIT = 50;
const MAX_FRAME_LIST_LIMIT = 200;
const DEFAULT_AGENT_LIST_LIMIT = 50;
const MAX_AGENT_LIST_LIMIT = 200;

class SessionTool extends PluginInterface {
  static pluginID = 'internal:sessions';
  static clientComponent = builtInToolComponent('kikx-session-tool-use');
  static riskLevel = 'none';

  frameRuntime() {
    let runtime = this.context.frameRuntime || this.context.services?.frameRuntime || resolveContextService(this.context, 'frameRuntime');
    if (!runtime)
      throw new Error(`${this.constructor.featureName} requires frameRuntime`);

    return runtime;
  }

  agentManager() {
    let agentManager = this.context.agentManager || this.context.services?.agentManager || resolveContextService(this.context, 'agentManager');
    if (!agentManager)
      throw new Error(`${this.constructor.featureName} requires agentManager`);

    return agentManager;
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

export class AgentListTool extends SessionTool {
  static featureName = 'agent-list';
  static displayName = 'List agents';
  static description = 'List configured Kikx agents that can be invited into sessions.';
  static frameType = 'AgentListToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_AGENT_LIST_LIMIT,
        description: 'Maximum number of agents to return.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Agent list offset.',
      },
      provider: {
        type: 'string',
        description: 'Optional provider/plugin ID filter.',
      },
      includeDisabled: {
        type: 'boolean',
        description: 'When true, include disabled agents. Defaults to false.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use agent-list to discover agent IDs and names before inviting agents into a session.';

  async _execute(params = {}) {
    let limit = clampInteger(params.limit, DEFAULT_AGENT_LIST_LIMIT, 1, MAX_AGENT_LIST_LIMIT);
    let offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let provider = normalizeOptionalString(params.provider);
    let includeDisabled = params.includeDisabled === true;
    let agents = await this.agentManager().listAgents({ limit, offset });
    let filtered = agents.filter((agent) => {
      if (!includeDisabled && agent.enabled === false)
        return false;

      if (provider && agent.pluginID !== provider)
        return false;

      return true;
    });

    return {
      agents: filtered.map((agent) => sanitizeAgent(agent)),
      count: filtered.length,
      limit,
      offset,
      provider: provider || null,
      includeDisabled,
    };
  }
}

export class SessionListTool extends SessionTool {
  static featureName = 'session-list';
  static displayName = 'List sessions';
  static description = 'List available Kikx sessions.';
  static frameType = 'SessionListToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_SESSION_LIST_LIMIT,
        description: 'Maximum number of sessions to return.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Session list offset.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use session-list to find existing session IDs and titles. Every tool also accepts session_id to make the visible tool call happen in that target session.';

  async _execute(params = {}) {
    let limit = clampInteger(params.limit, DEFAULT_SESSION_LIST_LIMIT, 1, MAX_SESSION_LIST_LIMIT);
    let offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let sessions = await this.frameRuntime().listSessions({ limit, offset });
    return {
      sessions: sessions.map((session) => sanitizeSession(session)),
      count: sessions.length,
      limit,
      offset,
      currentSessionID: this.context.session?.id || null,
    };
  }
}

export class SessionCreateTool extends SessionTool {
  static featureName = 'session-create';
  static displayName = 'Create session';
  static description = 'Create a new Kikx session.';
  static frameType = 'SessionCreateToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional session title. If omitted, Kikx assigns the next default Session number.',
      },
      participantAgentIDs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional agent IDs to invite into the new session.',
      },
      participantAgents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional agent IDs or exact agent names to resolve and invite into the new session.',
      },
      includeSelf: {
        type: 'boolean',
        description: 'When true, include the calling agent as a participant in the new session.',
      },
      initialMessage: {
        type: 'string',
        description: 'Optional first visible message to seed the new session. For delegated sub-agent work, use this as a compact orientation handoff: project name, cwd, goal, current status, constraints, and first assignment.',
      },
      reuseExisting: {
        type: 'boolean',
        description: 'For agent-created child sessions, reuse an existing same-title child under the same parent/creator. Defaults to true; set false only when a separate duplicate-title session is intentional.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use session-create to create a new session. Set includeSelf when you should participate in that new session. For delegated sub-agent work, set initialMessage to a compact orienting handoff with project name, cwd, parent goal, current status, constraints, and the first assignment. Agent-created child sessions reuse an existing same-title child under the same parent/creator by default; set reuseExisting false only when you intentionally need a separate duplicate-title session.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('session-create');

    let participantAgentIDs = normalizeStringArray(params.participantAgentIDs);
    let participantAgentRefs = normalizeStringArray(params.participantAgents);
    if (participantAgentRefs.length > 0) {
      let resolvedAgents = await resolveAgents(this.agentManager(), participantAgentRefs);
      participantAgentIDs = uniqueStrings([
        ...participantAgentIDs,
        ...resolvedAgents.map((agent) => agent.id),
      ]);
    }

    if (params.includeSelf === true && this.context.agent?.id && !participantAgentIDs.includes(this.context.agent.id))
      participantAgentIDs.push(this.context.agent.id);

    let sourceSession = this.sourceSession();
    let createdByAgentID = normalizeOptionalString(this.context.agent?.id);
    let title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : '';
    if (params.reuseExisting !== false) {
      let reusable = await findReusableChildSession(this.frameRuntime(), {
        title,
        parentSessionID: sourceSession?.id || null,
        createdByAgentID,
      });
      if (reusable) {
        return {
          session: sanitizeSession(reusable),
          created: false,
          reusedExisting: true,
          initialFrame: null,
        };
      }
    }

    let session = await this.frameRuntime().createSession({
      ...(title ? { title } : {}),
      participantAgentIDs,
      ...(createdByAgentID ? {
        createdByAgentID,
        parentSessionID: sourceSession?.id || null,
        generation: sessionGeneration(sourceSession) + 1,
      } : {}),
    });

    let initialMessage = normalizeOptionalString(params.initialMessage);
    let initialFrame = null;
    if (initialMessage) {
      let posted = await postAgentSessionMessage({
        runtime: this.frameRuntime(),
        context: this.context,
        agentManager: this.agentManager(),
        sessionID: session.id,
        text: initialMessage,
      });
      initialFrame = posted.frame;
    }

    return {
      session: sanitizeSession(session),
      created: true,
      reusedExisting: false,
      initialFrame,
    };
  }

  // A created/reused child session is a first-class reference: clicking the
  // result frame can enter that session.
  static referencesFor(result = {}) {
    let session = result?.session;
    if (!session?.id)
      return null;

    return [ {
      type: 'session',
      id: session.id,
      parentSessionID: session.parentSessionID || null,
      title: session.title || null,
      generation: session.generation ?? null,
    } ];
  }
}

export class SessionInviteAgentsTool extends SessionTool {
  static featureName = 'session-invite-agents';
  static displayName = 'Invite agents';
  static description = 'Invite one or more configured agents into a Kikx session.';
  static frameType = 'SessionInviteAgentsToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs or exact agent names to invite.',
      },
      includeSelf: {
        type: 'boolean',
        description: 'When true, invite the calling agent as well.',
      },
      wake: {
        type: 'boolean',
        description: 'Wake each newly invited agent with the session context. Defaults to true.',
      },
    },
    required: [ 'agents' ],
    additionalProperties: false,
  };
  static help = 'Use session-invite-agents with session_id to invite multiple existing agents into a target session. Values in agents may be agent IDs or exact agent names. Newly invited agents are woken with a hidden context-review turn by default; set wake:false to add them silently.';

  async _execute(params = {}) {
    this.assertFirstGenerationDelegation('session-invite-agents');

    let sessionID = requireTargetSessionID(this.targetSessionID(params));
    let refs = normalizeStringArray(params.agents || params.agentRefs || params.agentIDs);
    if (params.includeSelf === true && this.context.agent?.id)
      refs.push(this.context.agent.id);

    refs = uniqueStrings(refs);
    if (refs.length === 0)
      throw new TypeError('agents must contain at least one agent ID or name');

    let runtime = this.frameRuntime();
    let agents = await resolveAgents(this.agentManager(), refs);
    let invited = [];
    let wokeAgentIDs = [];
    let session = null;

    for (let agent of agents) {
      let result = await runtime.inviteAgentToSession(sessionID, agent, {
        invitedByAgentID: this.context.agent?.id || null,
      });
      session = result.session;
      invited.push({
        agent: sanitizeAgent(agent),
        alreadyParticipant: result.alreadyParticipant === true,
      });

      if (!result.alreadyParticipant && params.wake !== false && agent.id !== this.context.agent?.id) {
        await wakeInvitedAgent(runtime, {
          sessionID,
          session,
          agent,
          inviter: this.context.agent,
        });
        wokeAgentIDs.push(agent.id);
      }
    }

    return {
      sessionID,
      session: sanitizeSession(session || (await runtime.ensureSessionEntry(sessionID, { loadFrames: false })).session),
      invited,
      invitedAgentIDs: invited.map((entry) => entry.agent.id),
      wokeAgentIDs,
    };
  }
}

export class SessionGetTool extends SessionTool {
  static featureName = 'session-get';
  static displayName = 'Get session';
  static description = 'Inspect one Kikx session manifest.';
  static frameType = 'SessionGetToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  static help = 'Use session-get with session_id to inspect a specific session manifest; omit session_id for the current session.';

  async _execute(params = {}) {
    let sessionID = requireTargetSessionID(this.targetSessionID(params));
    let entry = await this.frameRuntime().ensureSessionEntry(sessionID, { loadFrames: false });
    return {
      session: sanitizeSession(entry.session),
    };
  }
}

export class SessionFramesTool extends SessionTool {
  static featureName = 'session-frames';
  static displayName = 'List session frames';
  static description = 'List recent frames in a Kikx session.';
  static frameType = 'SessionFramesToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_FRAME_LIST_LIMIT,
        description: 'Maximum number of frames to return.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Frame list offset.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use session-frames with session_id to inspect a session transcript. Returned frame content is summarized to keep the tool response bounded.';

  async _execute(params = {}) {
    let sessionID = requireTargetSessionID(this.targetSessionID(params));
    let limit = clampInteger(params.limit, DEFAULT_FRAME_LIST_LIMIT, 1, MAX_FRAME_LIST_LIMIT);
    let offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let frames = await this.frameRuntime().listFrames(sessionID, { limit, offset });
    return {
      sessionID,
      frames: frames.map((frame) => sanitizeFrame(frame)),
      count: frames.length,
      limit,
      offset,
    };
  }
}

export class SessionSearchTool extends SessionTool {
  static featureName = 'session-search';
  static displayName = 'Search session frames';
  static description = 'Search a Kikx session transcript in AeorDB and return frame hit locators.';
  static frameType = 'SessionSearchToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Broad fuzzy search query. At least one of query or where is required.',
      },
      where: {
        type: 'object',
        description: 'Structured AeorDB where clause scoped to this session frames index.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_FRAME_LIST_LIMIT,
        description: 'Maximum result count.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Result offset.',
      },
      maxMatchesPerResult: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum hit locators per result.',
      },
      snippetChars: {
        type: 'integer',
        minimum: 1,
        maximum: 4096,
        description: 'Maximum snippet characters per locator.',
      },
      matchContextLines: {
        type: 'integer',
        minimum: 0,
        description: 'Line context for stored-file fetch hints.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use session-search with session_id to search a session transcript. Results include frame paths and locator fetch hints; use database-fetch to read exact ranges.';

  async _execute(params = {}) {
    let sessionID = requireTargetSessionID(this.targetSessionID(params));
    let runtime = this.frameRuntime();
    let frameStore = runtime.frameStore;
    let aeordb = frameStore?.aeordb;
    if (!aeordb?.searchFiles)
      throw new Error('session-search requires frameRuntime.frameStore.aeordb.searchFiles');

    if (typeof frameStore.ensureSessionIndexConfigs === 'function')
      await frameStore.ensureSessionIndexConfigs(sessionID);

    let path = sessionFrameSearchPath(frameStore, sessionID);
    let search = createLocatorSearchRequest(params, { defaultPath: path });
    search.path = path;
    search.limit = clampInteger(params.limit, DEFAULT_FRAME_LIST_LIMIT, 1, MAX_FRAME_LIST_LIMIT);

    let result = await aeordb.searchFiles(search);
    let response = formatSearchResponse(result, {
      path,
      query: search.query || null,
      where: search.where || null,
    });

    response.sessionID = sessionID;
    response.results = response.results.map((entry) => ({
      ...entry,
      ...frameReferenceFromPath(entry.path),
    }));

    return response;
  }
}

export class SessionMessageTool extends SessionTool {
  static featureName = 'session-message';
  static displayName = 'Post session message';
  static description = 'Post a visible agent message into the current or target Kikx session.';
  static frameType = 'SessionMessageToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Visible message text to post into the target session.',
      },
    },
    required: [ 'text' ],
    additionalProperties: false,
  };
  static help = 'Use session-message with session_id to post a visible agent-authored message into another session. This is different from end-turn, which ends your current routed turn.';

  async _execute(params = {}) {
    let text = normalizeRequiredString(params.text, 'text');
    let runtime = this.frameRuntime();
    let sessionID = requireTargetSessionID(this.targetSessionID(params));
    // Only resolve the agent manager when the text contains a real mention;
    // plain messages (and email addresses) must keep working in contexts that
    // do not expose one.
    let agentManager = parseMentionReferences(text).length > 0 ? this.agentManager() : null;
    return await postAgentSessionMessage({
      runtime,
      context: this.context,
      agentManager,
      sessionID,
      text,
      interactionID: params.interactionID,
      agentID: params._agentID,
      sourceSessionID: params._sourceSessionID,
      sourceFrameID: params._frameID,
    });
  }
}
