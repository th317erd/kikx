'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { createLocatorSearchRequest, formatSearchResponse } from './database-tools.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

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
    },
    additionalProperties: false,
  };
  static help = 'Use session-create to create a new session. Set includeSelf when you should participate in that new session.';

  async _execute(params = {}) {
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

    let session = await this.frameRuntime().createSession({
      ...(typeof params.title === 'string' && params.title.trim() ? { title: params.title.trim() } : {}),
      participantAgentIDs,
    });

    return {
      session: sanitizeSession(session),
      created: true,
    };
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
    },
    required: [ 'agents' ],
    additionalProperties: false,
  };
  static help = 'Use session-invite-agents with session_id to invite multiple existing agents into a target session. Values in agents may be agent IDs or exact agent names.';

  async _execute(params = {}) {
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
    }

    return {
      sessionID,
      session: sanitizeSession(session || (await runtime.ensureSessionEntry(sessionID, { loadFrames: false })).session),
      invited,
      invitedAgentIDs: invited.map((entry) => entry.agent.id),
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
  static help = 'Use session-message with session_id to post a visible agent-authored message into another session. This is different from agent-respond, which finalizes your current routed turn.';

  async _execute(params = {}) {
    let text = normalizeRequiredString(params.text, 'text');
    let runtime = this.frameRuntime();
    let sessionID = requireTargetSessionID(this.targetSessionID(params));
    let entry = await runtime.ensureSessionEntry(sessionID);
    let stamp = typeof runtime.nextClockStamp === 'function'
      ? runtime.nextClockStamp()
      : { at: runtime.clock?.() || Date.now(), clock: null };
    let now = stamp.at;
    let frame = {
      id: runtime.idGenerator?.() || entry.frameEngine.idGenerator?.() || `session-message:${now}`,
      type: 'AgentMessage',
      sessionID,
      interactionID: params.interactionID || this.context.frame?.interactionID || runtime.idGenerator?.() || `interaction:${now}`,
      parentID: null,
      authorType: 'agent',
      authorID: this.context.agent?.id || params._agentID || null,
      authorDisplayName: this.context.agent?.name || this.context.agent?.id || params._agentID || null,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      createdClock: stamp.clock,
      updatedClock: stamp.clock,
      hidden: false,
      deleted: false,
      content: {
        text,
        status: 'complete',
        sourceSessionID: normalizeOptionalString(params._sourceSessionID || this.context.sourceSession?.id || this.context.frame?.sessionID),
        sourceFrameID: normalizeOptionalString(params._frameID || this.context.frame?.id),
      },
    };

    let merged = entry.frameEngine.merge([ frame ], {
      authorType: 'agent',
      authorID: frame.authorID,
    });
    await runtime.frameStore?.flush?.();

    return {
      sessionID,
      frame: sanitizeFrame(merged[0] || entry.frameEngine.get?.(frame.id) || frame),
      posted: true,
    };
  }
}

function sanitizeSession(session = {}) {
  return {
    id: session.id || null,
    title: session.title || session.id || '',
    organizationID: session.organizationID || null,
    createdByUserID: session.createdByUserID || null,
    messageCount: normalizeNonNegativeInteger(session.messageCount, 0),
    participantAgentIDs: normalizeStringArray(session.participantAgentIDs),
    coordinatorAgentID: session.coordinatorAgentID || null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    createdClock: session.createdClock || null,
    updatedClock: session.updatedClock || null,
  };
}

function sanitizeAgent(agent = {}) {
  return {
    id: agent.id || null,
    name: agent.name || agent.id || '',
    pluginID: agent.pluginID || null,
    enabled: agent.enabled !== false,
    character: typeof agent.character === 'string' ? agent.character : '',
    createdAt: agent.createdAt || null,
    updatedAt: agent.updatedAt || null,
  };
}

function sanitizeFrame(frame = {}) {
  return {
    id: frame.id || null,
    type: frame.type || null,
    sessionID: frame.sessionID || null,
    interactionID: frame.interactionID || null,
    parentID: frame.parentID || null,
    authorType: frame.authorType || null,
    authorID: frame.authorID || null,
    authorDisplayName: frame.authorDisplayName || null,
    createdAt: frame.createdAt || null,
    updatedAt: frame.updatedAt || null,
    createdClock: frame.createdClock || null,
    updatedClock: frame.updatedClock || null,
    hidden: frame.hidden === true,
    deleted: frame.deleted === true,
    content: summarizeFrameContent(frame.content),
  };
}

function sessionFrameSearchPath(frameStore, sessionID) {
  let rootPath = String(frameStore?.rootPath || '/kikx').replace(/\/+$/g, '');
  return `${rootPath}/sessions/${encodeURIComponent(sessionID)}/interactions`;
}

function frameReferenceFromPath(path) {
  let fileName = String(path || '').split('/').pop() || '';
  let match = fileName.match(/^\d+-([^-]+)-(.+)\.json$/);
  if (!match)
    return {};

  return {
    frameType: decodeURIComponent(match[1]),
    frameID: decodeURIComponent(match[2]),
  };
}

function summarizeFrameContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content))
    return content ?? null;

  let output = {};
  for (let [key, value] of Object.entries(content)) {
    if (typeof value === 'string')
      output[key] = value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
    else if (key === 'thinking' && value && typeof value === 'object')
      output[key] = { status: value.status || null, text: summarizeText(value.text) };
    else
      output[key] = value;
  }

  return output;
}

function summarizeText(value) {
  if (typeof value !== 'string')
    return '';

  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

function requireTargetSessionID(sessionID) {
  let normalized = normalizeOptionalString(sessionID);
  if (!normalized)
    throw new TypeError('session_id is required when no current session is available');

  return normalized;
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

async function resolveAgents(agentManager, refs) {
  let agents = [];
  for (let ref of refs) {
    let agent;
    if (typeof agentManager.resolveAgent === 'function') {
      agent = await agentManager.resolveAgent(ref);
    } else if (typeof agentManager.getAgent === 'function') {
      agent = await agentManager.getAgent(ref);
    } else {
      throw new Error('Agent resolution requires agentManager.resolveAgent() or getAgent()');
    }

    if (!agent?.id)
      throw new Error(`Agent not found: ${ref}`);

    if (!agents.some((candidate) => candidate.id === agent.id))
      agents.push(agent);
  }

  return agents;
}

function uniqueStrings(values) {
  let output = [];
  for (let value of values || []) {
    let normalized = normalizeOptionalString(value);
    if (normalized && !output.includes(normalized))
      output.push(normalized);
  }

  return output;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
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

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

function resolveContextService(context, name) {
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
