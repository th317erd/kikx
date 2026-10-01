'use strict';

import { ToolExecutionService } from '../tools/tool-execution-service.mjs';
import {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAME_PATTERN,
  DELEGATION_TOOL_NAMES,
  REVIEW_ONLY_AGENT_PATTERN,
  REVIEW_ONLY_TOOL_DENYLIST,
} from './agent-tool-definitions.mjs';
import {
  cloneJSON,
  normalizeContinuationRequest,
  normalizeOptionalPromptString,
  normalizeReason,
  normalizeRequiredToolString,
  normalizeRouteRequest,
  normalizeStringArray,
  normalizeToolResponseContent,
  readToolString,
  resolveService,
  sessionGeneration,
} from './agent-normalizers.mjs';
import { recordForward } from './agent-loop-state.mjs';

export function createLoopToolDefinitions(context = {}) {
  let loopDefinitions = AGENT_TOOL_DEFINITIONS
    .filter((toolDefinition) => shouldExposeLoopTool(toolDefinition.name, context))
    .map((toolDefinition) => ({
      ...toolDefinition,
      parameters: cloneJSON(toolDefinition.parameters),
    }));

  return mergeToolDefinitions(loopDefinitions, createRegisteredToolDefinitions(context));
}

export function createLoopTools(state, context) {
  let respond = (content) => {
    state.finalized = true;
    state.continuation = null;
    state.finalFrame = {
      type: 'AgentMessage',
      content: normalizeToolResponseContent(content),
    };
    return { type: 'LoopControl', action: 'finalize', content: state.finalFrame.content };
  };
  let respondAndContinue = (content) => {
    let continuation = normalizeContinuationRequest(content);
    state.finalized = true;
    state.continuation = continuation;
    state.finalFrame = {
      type: 'AgentMessage',
      content: normalizeToolResponseContent(content),
    };
    return {
      type: 'LoopControl',
      action: 'respond-and-continue',
      content: state.finalFrame.content,
      continuation,
    };
  };
  let finalize = (content) => respond(content);
  let nullResponse = (reason = '') => {
    state.nullResponse = true;
    return { type: 'LoopControl', action: 'null-response', reason: normalizeReason(reason) };
  };
  let route = (input = {}) => {
    let request = normalizeRouteRequest(input);
    recordForward(state, request);
    return { type: 'LoopControl', action: 'route', ...request };
  };
  let breakLoop = (reason = '') => {
    state.break = true;
    return { type: 'LoopControl', action: 'break', reason: normalizeReason(reason) };
  };
  let progress = async (content) => await recordAgentProgress(content, context);
  let setCharacter = async (input) => await setAgentCharacter(input, context);

  let tools = {
    'agent-respond': respond,
    'agent-respond-and-continue': respondAndContinue,
    'agent-finalize': finalize,
    'loop-break': breakLoop,
    'agent-progress': progress,
    'agent-character-set': setCharacter,
  };

  if (shouldExposeLoopTool('agent-null-response', context))
    tools['agent-null-response'] = nullResponse;

  if (context.isCoordinator === true)
    tools['route'] = route;

  for (let [toolName, handler] of Object.entries(createRegisteredToolHandlers(context))) {
    if (!tools[toolName])
      tools[toolName] = handler;
  }

  return tools;
}

export function shouldExposeLoopTool(toolName, context = {}) {
  if (toolName === 'route')
    return context.isCoordinator === true;

  if (toolName === 'agent-null-response' && isSoleAgentUserTurn(context))
    return false;

  return true;
}

export function isSoleAgentUserTurn(context = {}) {
  let participantAgentIDs = normalizeStringArray(context.participantAgentIDs || context.session?.participantAgentIDs);
  let frame = context.frame || {};

  return participantAgentIDs.length <= 1
    && frame.authorType === 'user'
    && frame.hidden !== true
    && frame.deleted !== true;
}

export function createRegisteredToolDefinitions(context = {}) {
  let pluginRegistry = resolvePluginRegistry(context);
  if (!pluginRegistry?.getTools)
    return [];

  let definitions = [];
  for (let [toolName, ToolClass] of pluginRegistry.getTools()) {
    if (!shouldExposeRegisteredTool(toolName, ToolClass, context))
      continue;

    definitions.push({
      name: toolName,
      description: ToolClass.description || ToolClass.displayName || toolName,
      help: ToolClass.help || ToolClass.description || '',
      parameters: withCrossSessionToolParameter(cloneJSON(ToolClass.inputSchema || {
        type: 'object',
        properties: {},
        additionalProperties: false,
      })),
    });
  }

  return definitions;
}

export function withCrossSessionToolParameter(schema) {
  let output = (schema && typeof schema === 'object' && !Array.isArray(schema))
    ? schema
    : {};

  if (output.type && output.type !== 'object')
    return output;

  output.type = 'object';
  output.properties = (output.properties && typeof output.properties === 'object' && !Array.isArray(output.properties))
    ? output.properties
    : {};

  if (!output.properties.session_id) {
    output.properties.session_id = {
      type: 'string',
      description: 'Optional target Kikx session ID. When set, this tool call/result is recorded in that session.',
    };
  }

  if (output.additionalProperties == null)
    output.additionalProperties = false;

  return output;
}

export function createRegisteredToolHandlers(context = {}) {
  let pluginRegistry = resolvePluginRegistry(context);
  if (!pluginRegistry?.getTools)
    return {};

  let toolExecutor = resolveToolExecutor(context);
  let handlers = {};
  for (let [toolName, ToolClass] of pluginRegistry.getTools()) {
    if (!shouldExposeRegisteredTool(toolName, ToolClass, context))
      continue;

    handlers[toolName] = async (input = {}) => {
      return await toolExecutor.executeTool({
        toolName,
        ToolClass,
        input,
        context,
      });
    };
  }

  return handlers;
}

export function resolveToolExecutor(context = {}) {
  return context.toolExecutor
    || context.services?.toolExecutor
    || resolveService(context.services, 'toolExecutor')
    || new ToolExecutionService();
}

export function shouldExposeRegisteredTool(toolName, ToolClass, context = {}) {
  return typeof toolName === 'string'
    && toolName.trim() !== ''
    && AGENT_TOOL_NAME_PATTERN.test(toolName)
    && ToolClass?.exposeToAgents !== false
    && shouldExposeDelegationTool(toolName, context)
    && shouldExposeRoleTool(toolName, context);
}

export function shouldExposeDelegationTool(toolName, context = {}) {
  if (!DELEGATION_TOOL_NAMES.has(toolName))
    return true;

  return sessionGeneration(context.session) <= 0;
}

export function shouldExposeRoleTool(toolName, context = {}) {
  if (!REVIEW_ONLY_TOOL_DENYLIST.has(toolName))
    return true;

  if (hasExplicitWriteFilePermission(context))
    return true;

  return !isReviewOnlyAgent(context.agent);
}

export function hasExplicitWriteFilePermission(context = {}) {
  return context.allowWriteFile === true
    || context.agent?.allowWriteFile === true
    || context.agent?.permissions?.writeFile === true
    || context.agent?.config?.allowWriteFile === true
    || context.agent?.config?.permissions?.writeFile === true;
}

export function isReviewOnlyAgent(agent = {}) {
  let text = [
    agent.id,
    agent.name,
    agent.role,
    agent.character,
    agent.config?.role,
    agent.config?.character,
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join(' ');

  return REVIEW_ONLY_AGENT_PATTERN.test(text);
}

export function mergeToolDefinitions(primary, secondary) {
  let merged = [];
  let seen = new Set();

  for (let definition of [ ...primary, ...secondary ]) {
    if (!definition?.name || seen.has(definition.name))
      continue;

    seen.add(definition.name);
    merged.push(definition);
  }

  return merged;
}

export async function dispatchForwards(context, state) {
  let forwardFrame = context.services?.forwardFrame;
  if (typeof forwardFrame !== 'function')
    return;

  for (let forward of state.forwards) {
    await forwardFrame({
      frame: context.frame,
      userFrame: context.userFrame || context.frame,
      agent: context.agent,
      session: context.session,
      targets: forward.targets,
      remove: forward.remove,
      message: forward.message,
    });
  }
}

export async function setAgentCharacter(input, context = {}) {
  let character = normalizeRequiredToolString(readToolString(input, [ 'character', 'description', 'text' ]), 'character');
  let agentID = normalizeRequiredToolString(context.agent?.id, 'agent.id');
  let agentManager = resolveService(context.services, 'agentManager');
  if (!agentManager)
    throw new Error('agent-character-set requires agentManager');

  let updated;
  if (typeof agentManager.updateAgentCharacter === 'function') {
    updated = await agentManager.updateAgentCharacter(agentID, character);
  } else if (typeof agentManager.updateAgent === 'function') {
    updated = await agentManager.updateAgent(agentID, { character });
  } else {
    throw new Error('agent-character-set requires agentManager.updateAgentCharacter()');
  }

  if (context.agent)
    context.agent.character = updated?.character || character;

  return {
    type: 'ToolResult',
    action: 'agent-character-set',
    content: {
      agentID,
      character: updated?.character || character,
    },
  };
}

export async function recordAgentProgress(input, context = {}) {
  let text = normalizeRequiredToolString(readToolString(input, [ 'text', 'message', 'progress' ]), 'text');
  let frameEngine = resolveFrameEngine(context);
  let sessionID = normalizeOptionalPromptString(context.session?.id || context.frame?.sessionID);
  let agentID = normalizeOptionalPromptString(context.agent?.id);
  if (!frameEngine || !sessionID || !agentID) {
    return {
      type: 'ToolResult',
      action: 'agent-progress',
      content: {
        text,
        visible: false,
      },
    };
  }

  let now = resolveClock(context)();
  let progressFrame = {
    id: typeof frameEngine.idGenerator === 'function' ? frameEngine.idGenerator() : `agent-progress:${now}`,
    type: 'AgentProgress',
    sessionID,
    interactionID: context.frame?.interactionID || null,
    parentID: context.responseFrameID || context.frame?.id || null,
    authorType: 'agent',
    authorID: agentID,
    authorDisplayName: context.agent?.name || agentID,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    hidden: false,
    deleted: false,
    agentRoute: context.responseFrameID ? frameEngine.get?.(context.responseFrameID)?.agentRoute : undefined,
    content: {
      text,
      status: 'progress',
      responseFrameID: context.responseFrameID || null,
    },
  };

  frameEngine.merge([ progressFrame ], {
    authorType: 'agent',
    authorID: agentID,
  });
  await context.services?.frameRuntime?.frameStore?.flush?.();

  return {
    type: 'ToolResult',
    action: 'agent-progress',
    content: {
      text,
      visible: true,
      frameID: progressFrame.id,
    },
  };
}

export function resolveFrameEngine(context = {}) {
  return context.frameEngine
    || context.services?.frameEngine
    || resolveService(context.services, 'frameEngine');
}

export function resolveClock(context = {}) {
  if (typeof context.services?.clock === 'function')
    return context.services.clock;

  if (typeof context.clock === 'function')
    return context.clock;

  return () => Date.now();
}

export function resolvePluginRegistry(context = {}) {
  if (context.pluginRegistry)
    return context.pluginRegistry;

  return resolveService(context.services, 'pluginRegistry');
}
