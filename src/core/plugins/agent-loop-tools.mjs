'use strict';

import { ToolExecutionService } from '../tools/tool-execution-service.mjs';
import {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAME_PATTERN,
  DELEGATION_TOOL_NAMES,
  REVIEW_ONLY_AGENT_PATTERN,
  REVIEW_ONLY_TOOL_DENYLIST,
} from './agent-tool-definitions.mjs';
import { normalizeMood, normalizeMoodWord } from '../../shared/mood.mjs';
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
import {
  CHARACTER_COMPRESSED_FIELD,
  MAX_CHARACTER_COMPRESSED_LENGTH,
} from '../agents/character-limits.mjs';

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
  // `end-turn` sends a visible report when `summary`/`details` are present, or
  // ends the turn silently when both are omitted/empty (replacing the old
  // null-response).
  let endTurn = (content) => {
    state.finalized = true;
    state.continuation = null;
    let normalized = normalizeToolResponseContent(content);
    let summary = normalizeBulletedSummary(content?.summary);
    let details = normalizeReportDetails(content?.details);
    if (summary !== '') {
      normalized = {
        ...normalized,
        text: details || summary,
        summary,
        turnReport: true,
      };
    }
    let hasText = typeof normalized.text === 'string' && normalized.text.trim() !== '';
    state.finalFrame = hasText
      ? { type: 'AgentMessage', content: normalized }
      : null;
    return { type: 'LoopControl', action: 'finalize', content: normalized };
  };
  let continueTurn = (content) => {
    let payload = (content && typeof content === 'object' && !Array.isArray(content)) ? content : {};
    let mood = normalizeMood(payload.mood);
    let moodWord = normalizeMoodWord(payload.moodWord);
    let continuation = normalizeContinuationRequest({
      ...payload,
      prompt: payload.nextAction || payload.continuationPrompt || payload.text,
    });
    state.finalized = true;
    state.continuation = continuation;
    let normalized = { ...normalizeToolResponseContent(content), mood, moodWord };
    let hasText = typeof normalized.text === 'string' && normalized.text.trim() !== '';
    state.finalFrame = hasText
      ? { type: 'AgentMessage', content: normalized }
      : null;
    return {
      type: 'LoopControl',
      action: 'respond-and-continue',
      content: normalized,
      continuation,
    };
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
  let help = (input) => formatToolHelp(input, context);

  let tools = {
    'end-turn': endTurn,
    'continue-turn': continueTurn,
    'stop': breakLoop,
    'progress': progress,
    'set-character': setCharacter,
    'help': help,
  };

  if (context.isCoordinator === true)
    tools['route'] = route;

  for (let [toolName, handler] of Object.entries(createRegisteredToolHandlers(context))) {
    if (!tools[toolName])
      tools[toolName] = handler;
  }

  return tools;
}

export function shouldExposeLoopTool(toolName, context = {}) {
  if (toolName === 'route' || toolName === 'session-control')
    return context.isCoordinator === true;

  return true;
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
      }), ToolClass),
    });
  }

  return definitions;
}

export function withCrossSessionToolParameter(schema, ToolClass = null) {
  let output = (schema && typeof schema === 'object' && !Array.isArray(schema))
    ? schema
    : {};

  if (output.type && output.type !== 'object')
    return output;

  output.type = 'object';
  output.properties = (output.properties && typeof output.properties === 'object' && !Array.isArray(output.properties))
    ? output.properties
    : {};

  let requiresTarget = ToolClass?.requiresTargetSessionID === true;
  if (!output.properties.session_id) {
    output.properties.session_id = {
      type: 'string',
      minLength: 1,
      description: requiresTarget
        ? 'Required target Kikx session ID. This tool writes to or controls that session. Call session-list with query=<title or id fragment> to find the exact ID; do not omit it or guess.'
        : 'Target Kikx session ID. The tool executes against that session; omit only to use the current session for read-only inspection. Use session-list to find an exact ID before changing another session.',
    };
  }

  if (requiresTarget) {
    output.required = Array.isArray(output.required) ? output.required : [];
    if (!output.required.includes('session_id'))
      output.required.push('session_id');
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
    if (!shouldExposeLoopTool(toolName, context)
      || !shouldExposeRegisteredTool(toolName, ToolClass, context))
      continue;

    handlers[toolName] = async (input = {}) => {
      // A user/actor message that arrived while the previous tool was running
      // must win before the next side effect. Returning a LoopControl makes the
      // provider tool loop stop and hand the turn back to core, which sees the
      // steering flag and starts the new message's turn.
      let interrupt = pendingTurnInterrupt(context);
      if (interrupt)
        return interrupt;

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

function pendingTurnInterrupt(context = {}) {
  let runtime = context.frameRuntime || context.services?.frameRuntime;
  let sessionID = context.session?.id || context.frame?.sessionID;
  let agentID = context.agent?.id;
  if (!runtime || !sessionID || !agentID)
    return null;
  if (runtime.hasAgentCancellation?.(sessionID, agentID) === true)
    return { type: 'LoopControl', action: 'break', reason: 'cancelled' };
  if (runtime.hasAgentSteering?.(sessionID, agentID) === true)
    return { type: 'LoopControl', action: 'break', reason: 'steering' };
  return null;
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

// `help` tool: list every exposed tool with its one-line help, or return the
// full help/description/parameters for a single named tool. Builds the list from
// the same definitions the model received, so help can never drift from the
// actual tool set (including plugin-registered tools).
export function formatToolHelp(input = {}, context = {}) {
  let definitions = createLoopToolDefinitions(context);
  let requestedTool = readToolString(input, [ 'tool', 'toolName', 'name' ]).trim();

  if (requestedTool) {
    let match = definitions.find((definition) => definition.name === requestedTool);
    if (!match) {
      let names = definitions.map((definition) => definition.name).sort();
      return {
        type: 'ToolResult',
        action: 'help',
        content: {
          tool: requestedTool,
          found: false,
          message: `Unknown tool: ${requestedTool}. Available tools: ${names.join(', ')}`,
        },
      };
    }

    return {
      type: 'ToolResult',
      action: 'help',
      content: {
        tool: match.name,
        found: true,
        description: match.description || '',
        help: match.help || match.description || '',
        parameters: cloneJSON(match.parameters || {}),
      },
    };
  }

  let tools = definitions.map((definition) => ({
    name: definition.name,
    help: definition.help || definition.description || '',
  })).sort((left, right) => left.name.localeCompare(right.name));
  let text = tools.map((tool) => `- ${tool.name}: ${tool.help}`).join('\n');

  return {
    type: 'ToolResult',
    action: 'help',
    content: {
      tools,
      text,
    },
  };
}

export async function setAgentCharacter(input, context = {}) {
  let character = normalizeRequiredToolString(readToolString(input, [ 'character', 'description', 'text' ]), 'character');
  let compressedCharacter = normalizeRequiredToolString(
    readToolString(input, [
      'compressedCharacter',
      'compressedVersion',
      'shortVersion',
      'compressed',
      'characterShort',
      'shortCharacter',
    ]),
    'compressedCharacter',
  );
  if (compressedCharacter.length > MAX_CHARACTER_COMPRESSED_LENGTH)
    throw new TypeError(`compressedCharacter must be ${MAX_CHARACTER_COMPRESSED_LENGTH} characters or fewer`);

  let agentID = normalizeRequiredToolString(context.agent?.id, 'agent.id');
  let agentManager = resolveService(context.services, 'agentManager');
  if (!agentManager)
    throw new Error('set-character requires agentManager');

  let updated;
  if (typeof agentManager.updateAgentCharacter === 'function') {
    updated = await agentManager.updateAgentCharacter(agentID, character, compressedCharacter);
  } else if (typeof agentManager.updateAgent === 'function') {
    updated = await agentManager.updateAgent(agentID, {
      character,
      [CHARACTER_COMPRESSED_FIELD]: compressedCharacter,
    });
  } else {
    throw new Error('set-character requires agentManager.updateAgentCharacter()');
  }

  if (context.agent) {
    context.agent.character = updated?.character || character;
    context.agent[CHARACTER_COMPRESSED_FIELD] = updated?.[CHARACTER_COMPRESSED_FIELD] || compressedCharacter;
  }

  return {
    type: 'ToolResult',
    action: 'set-character',
    content: {
      agentID,
      character: updated?.character || character,
      [CHARACTER_COMPRESSED_FIELD]: updated?.[CHARACTER_COMPRESSED_FIELD] || compressedCharacter,
    },
  };
}

export async function recordAgentProgress(input, context = {}) {
  let text = normalizeRequiredToolString(readToolString(input, [ 'text', 'message', 'progress' ]), 'text');
  let mood = normalizeMood(input?.mood);
  let moodWord = normalizeMoodWord(input?.moodWord);
  let frameEngine = resolveFrameEngine(context);
  let sessionID = normalizeOptionalPromptString(context.session?.id || context.frame?.sessionID);
  let agentID = normalizeOptionalPromptString(context.agent?.id);
  if (!frameEngine || !sessionID || !agentID) {
    return {
      type: 'ToolResult',
      action: 'progress',
      content: {
        text,
        mood,
        moodWord,
        visible: false,
      },
    };
  }

  let now = resolveClock(context)();
  let progressFrame = {
    id: typeof frameEngine.idGenerator === 'function' ? frameEngine.idGenerator() : `progress:${now}`,
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
      mood,
      moodWord,
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
    action: 'progress',
    content: {
      text,
      mood,
      moodWord,
      visible: true,
      frameID: progressFrame.id,
    },
  };
}

function normalizeBulletedSummary(value) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (text === '')
    return '';

  let lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let firstBullet = lines.findIndex(isBulletLine);
  if (firstBullet === -1)
    return lines.map((line) => `- ${line}`).join('\n');

  // Keep the goals-completed paragraph as prose; only the steps after it form
  // the bulleted list. Legacy bullet-only summaries remain unchanged.
  let intro = lines.slice(0, firstBullet);
  let steps = lines
    .slice(firstBullet)
    .map((line) => isBulletLine(line) ? line : `- ${line}`);

  return intro.length > 0
    ? `${intro.join('\n')}\n\n${steps.join('\n')}`
    : steps.join('\n');
}

function isBulletLine(line) {
  return /^[-*•]\s+/.test(line);
}

function normalizeReportDetails(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : '';
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
