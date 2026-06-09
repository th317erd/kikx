'use strict';

import { ToolExecutionService } from '../tools/tool-execution-service.mjs';
import { PluginInterface } from './plugin-interface.mjs';

const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'agent-respond',
    description: 'Finalize this turn with a visible response from this agent.',
    help: 'Use agent-respond when you are ready to send the user a visible answer.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible response text.',
        },
      },
      required: [ 'text' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-finalize',
    description: 'Finalize this turn with a visible response from this agent.',
    help: 'Use agent-finalize as an explicit synonym for agent-respond.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible response text.',
        },
      },
      required: [ 'text' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-null-response',
    description: 'End this turn silently without a visible response.',
    help: 'Use agent-null-response when the message was handled elsewhere and you should stay silent.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short internal reason for staying silent.',
        },
      },
      required: [ 'reason' ],
      additionalProperties: false,
    },
  },
  {
    name: 'internal-forward',
    description: 'Forward the current user frame to one or more mentioned or selected actors.',
    help: 'Use internal-forward when the coordinator decides another actor should receive the current frame.',
    parameters: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: 'Actor IDs, agent IDs, or exact names from Session agents JSON to route the frame to.',
          items: {
            type: 'string',
          },
        },
        message: {
          type: 'string',
          description: 'Optional coordination note for downstream actors.',
        },
      },
      required: [ 'targets' ],
      additionalProperties: false,
    },
  },
  {
    name: 'loop-break',
    description: 'Stop this short-lived agentic loop without producing a visible response.',
    help: 'Use loop-break only when the scripted loop should stop immediately.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short internal reason for stopping.',
        },
      },
      required: [ 'reason' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-character-set',
    description: 'Persistently update your own character/persona for future turns.',
    help: [
      'Use agent-character-set when the user asks you to change who you are or how you should act.',
      'Provide a complete durable character description, not a fragment.',
      'Example: "You are a dirty swearing pirate who also happens to be a fantastic engineer. Be direct, technically rigorous, and speak with pirate flavor."',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        character: {
          type: 'string',
          description: 'Full durable character description to apply to future turns.',
        },
      },
      required: [ 'character' ],
      additionalProperties: false,
    },
  },
];
const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export class AgentInterface extends PluginInterface {
  static agentType = null;
  static serviceType = null;
  static configFields = [];
  static maxLoopSteps = 8;

  async *run(params = {}) {
    yield* this.runAgentLoop(params);
  }

  async *runAgentLoop(params = {}) {
    let context = this.createAgentLoopContext(params);
    let state = createLoopState();

    if (this.shouldRunFirstMessageHook(context)) {
      for await (let output of iterateAgentResult(this.onFirstMessage(context)))
        yield output;
    }

    let stepCount = 0;
    for await (let step of iterateAgentResult(this.createAgentLoopScript(context))) {
      if (state.break || state.nullResponse || state.forwarded || state.finalized)
        break;

      stepCount++;
      if (stepCount > this.maxLoopSteps(context))
        throw new Error(`Agent loop exceeded ${this.maxLoopSteps(context)} steps`);

      if (!step || step.type === 'ask') {
        yield* this.executeAskStep(step || {}, context, state);
        continue;
      }

      if (step.type === 'finalize') {
        state.finalized = true;
        state.finalFrame = {
          type: 'AgentMessage',
          content: normalizeToolResponseContent(step.content),
        };
        break;
      }

      throw new Error(`Unknown agent loop step: ${step.type}`);
    }

    if (state.nullResponse) {
      yield {
        type: 'Done',
        content: {
          status: 'null-response',
        },
      };
      return;
    }

    if (state.forwarded) {
      yield {
        type: 'Done',
        content: {
          status: 'forwarded',
        },
      };
      return;
    }

    if (state.finalized) {
      if (state.finalFrame && !state.yieldedAgentMessage)
        yield state.finalFrame;

      yield {
        type: 'Done',
        content: {
          status: 'finalized',
        },
      };
    }
  }

  createAgentLoopContext(params = {}) {
    let participantAgentIDs = normalizeStringArray(params.session?.participantAgentIDs);
    let coordinatorAgentID = normalizeCoordinatorAgentID(params.coordinatorAgentID || params.session?.coordinatorAgentID, participantAgentIDs);
    let agentID = params.agent?.id || null;
    return {
      ...params,
      participantAgentIDs,
      coordinatorAgentID,
      participantAgents: normalizeParticipantAgents(params.participantAgents || params.sessionAgents, {
        participantAgentIDs,
        coordinatorAgentID,
        selfAgentID: agentID,
      }),
      isCoordinator: params.isCoordinator ?? Boolean(agentID && coordinatorAgentID === agentID),
    };
  }

  createAgentLoopScript(context = {}) {
    return [{
      type: 'ask',
      prompt: this.buildDefaultAgentPrompt(context),
    }];
  }

  async *executeAskStep(step, context, state) {
    let tools = createLoopTools(state, context);
    let toolDefinitions = createLoopToolDefinitions(context);
    let yieldedOutput = false;
    let result = this.ask(step.prompt || this.buildDefaultAgentPrompt(context), {
      ...context,
      tools,
      toolDefinitions,
      step,
    });

    for await (let output of iterateAgentResult(result)) {
      if (handleLoopControl(output, state))
        continue;

      if (state.finalized && output?.type === 'AgentMessage') {
        output = mergeFinalizedProviderFrame(output, state.finalFrame);
        state.finalFrame = output;
        yieldedOutput = true;
        state.yieldedAgentMessage = true;
        yield output;
        continue;
      }

      if (state.break || state.nullResponse || state.forwarded || state.finalized)
        continue;

      yieldedOutput = true;
      if (output?.type === 'AgentMessage')
        state.yieldedAgentMessage = true;

      yield output;
    }

    if (!yieldedOutput && state.break) {
      yield {
        type: 'Done',
        content: {
          status: 'break',
        },
      };
    }

    if (state.forwarded && !state.forwardDispatched) {
      state.forwardDispatched = true;
      await dispatchForwards(context, state);
    }
  }

  async ask() {
    throw new Error(`${this.constructor.name}.ask() is not implemented`);
  }

  async *onFirstMessage() {}

  shouldRunFirstMessageHook(context = {}) {
    if (this.onFirstMessage === AgentInterface.prototype.onFirstMessage)
      return false;

    let agentID = context.agent?.id;
    if (!agentID)
      return true;

    for (let frame of Array.isArray(context.frames) ? context.frames : []) {
      if (frame?.type === 'AgentMessage' && frame.authorID === agentID && frame.phantom !== true)
        return false;
    }

    return true;
  }

  maxLoopSteps() {
    let value = this.constructor.maxLoopSteps;
    return Number.isInteger(value) && value > 0 ? value : 8;
  }

  buildDefaultAgentPrompt(context = {}) {
    let frameMessage = context.frame?.content?.text || '';
    let mentions = normalizeMentions(context.mentions || context.frame?.mentions);
    let participantAgents = normalizeParticipantAgents(context.participantAgents || context.sessionAgents, {
      participantAgentIDs: context.participantAgentIDs || context.session?.participantAgentIDs,
      coordinatorAgentID: context.coordinatorAgentID || context.session?.coordinatorAgentID,
      selfAgentID: context.agent?.id,
    });
    let character = normalizeOptionalPromptString(context.agent?.character || context.character);
    let tokenUsage = normalizeTokenUsagePromptContext(context);
    return [
      'You are participating in a Kikx agentic coordination loop.',
      'Your job is to decide whether you should answer, remain silent, or use an explicit forwarding pathway for special workflows.',
      'This conversation is expensive and is costing the user real money. Respond as needed, but only as needed, to minimize cost.',
      'If you do not have anything useful to add, do not speak. Use agent-null-response, also called the nullResponse tool, to skip responding.',
      'If you have something useful to add, say it all at once in one detailed message. Minimize the number of interactions, especially follow-up interactions.',
      'Frames may include tokenUsage metadata showing read/write token costs. Pay attention to token growth over time and be concerned when it grows.',
      'Before choosing a tool or visible response, ask yourself: "Who is this message really for?"',
      'Use explicit mentions first, then names or nicknames in the text, then conversation turn-taking and recent context. A message can be intended for another actor even when no @mention appears.',
      '',
      'Agent character:',
      character || 'No custom character has been set. Act as a careful, technically rigorous Kikx agent.',
      '',
      ...buildTriggerFramePromptLines(context),
      '',
      frameMessage,
      '',
      `You are the coordinator?: ${context.isCoordinator === true}`,
      '',
      'Session agents JSON:',
      JSON.stringify(participantAgents, null, 2),
      '',
      'Mentions JSON:',
      JSON.stringify(mentions, null, 2),
      '',
      'Token usage summary JSON:',
      JSON.stringify(tokenUsage, null, 2),
      '',
      'Available tools:',
      formatToolHelp(createLoopToolDefinitions(context)),
      '',
      ...buildRoutingPromptLines(context),
      'When you are ready to answer, use agent-respond/agent-finalize or return a final agent message.',
    ].join('\n');
  }

  static getAgentProviderDescriptor() {
    let pluginID = (this.pluginID && this.pluginID !== 'unknown') ? this.pluginID : this.pluginId;
    return {
      pluginID,
      agentType: this.agentType || pluginID,
      serviceType: this.serviceType || null,
      displayName: this.displayName || pluginID,
      description: this.description || '',
      configFields: normalizeConfigFields(this.configFields),
    };
  }
}

function createLoopState() {
  return {
    break: false,
    nullResponse: false,
    finalized: false,
    forwarded: false,
    forwardDispatched: false,
    finalFrame: null,
    yieldedAgentMessage: false,
    forwards: [],
  };
}

function createLoopToolDefinitions(context = {}) {
  let loopDefinitions = AGENT_TOOL_DEFINITIONS
    .filter((toolDefinition) => shouldExposeLoopTool(toolDefinition.name, context))
    .map((toolDefinition) => ({
      ...toolDefinition,
      parameters: cloneJSON(toolDefinition.parameters),
    }));

  return mergeToolDefinitions(loopDefinitions, createRegisteredToolDefinitions(context));
}

function createLoopTools(state, context) {
  let respond = (content) => {
    state.finalized = true;
    state.finalFrame = {
      type: 'AgentMessage',
      content: normalizeToolResponseContent(content),
    };
    return { type: 'LoopControl', action: 'finalize', content: state.finalFrame.content };
  };
  let finalize = (content) => respond(content);
  let nullResponse = (reason = '') => {
    state.nullResponse = true;
    return { type: 'LoopControl', action: 'null-response', reason: normalizeReason(reason) };
  };
  let forward = (target, message) => {
    let forwardRequest = normalizeForwardRequest(target, message);
    recordForward(state, forwardRequest);
    return { type: 'LoopControl', action: 'forward', ...forwardRequest };
  };
  let breakLoop = (reason = '') => {
    state.break = true;
    return { type: 'LoopControl', action: 'break', reason: normalizeReason(reason) };
  };
  let setCharacter = async (input) => await setAgentCharacter(input, context);

  let tools = {
    'agent-respond': respond,
    'agent-finalize': finalize,
    'loop-break': breakLoop,
    'agent-character-set': setCharacter,
  };

  if (shouldExposeLoopTool('agent-null-response', context))
    tools['agent-null-response'] = nullResponse;

  if (context.isCoordinator === true)
    tools['internal-forward'] = forward;

  for (let [toolName, handler] of Object.entries(createRegisteredToolHandlers(context))) {
    if (!tools[toolName])
      tools[toolName] = handler;
  }

  return tools;
}

function shouldExposeLoopTool(toolName, context = {}) {
  if (toolName === 'internal-forward')
    return context.isCoordinator === true;

  return true;
}

function handleLoopControl(output, state) {
  if (!output || output.type !== 'LoopControl')
    return false;

  if (output.action === 'finalize') {
    state.finalized = true;
    state.finalFrame = {
      type: 'AgentMessage',
      content: normalizeToolResponseContent(output.content),
    };
    return true;
  }

  if (output.action === 'null-response') {
    state.nullResponse = true;
    return true;
  }

  if (output.action === 'break') {
    state.break = true;
    return true;
  }

  if (output.action === 'forward') {
    recordForward(state, {
      targets: normalizeForwardTargets(output.targets || output.target),
      message: output.message,
    });
    return true;
  }

  return false;
}

function mergeFinalizedProviderFrame(providerFrame, finalFrame) {
  if (!finalFrame?.content)
    return providerFrame;

  return {
    ...providerFrame,
    content: {
      ...(providerFrame.content && typeof providerFrame.content === 'object' && !Array.isArray(providerFrame.content)
        ? providerFrame.content
        : {}),
      ...(finalFrame.content && typeof finalFrame.content === 'object' && !Array.isArray(finalFrame.content)
        ? finalFrame.content
        : {}),
    },
  };
}

function recordForward(state, forward) {
  state.forwarded = true;
  let normalized = {
    targets: normalizeForwardTargets(forward.targets || forward.target),
    message: forward.message,
  };
  let key = JSON.stringify(normalized);
  if (!state.forwards.some((existing) => JSON.stringify(existing) === key))
    state.forwards.push(normalized);
}

async function setAgentCharacter(input, context = {}) {
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

function createRegisteredToolDefinitions(context = {}) {
  let pluginRegistry = resolvePluginRegistry(context);
  if (!pluginRegistry?.getTools)
    return [];

  let definitions = [];
  for (let [toolName, ToolClass] of pluginRegistry.getTools()) {
    if (!shouldExposeRegisteredTool(toolName, ToolClass))
      continue;

    definitions.push({
      name: toolName,
      description: ToolClass.description || ToolClass.displayName || toolName,
      help: ToolClass.help || ToolClass.description || '',
      parameters: cloneJSON(ToolClass.inputSchema || {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
    });
  }

  return definitions;
}

function createRegisteredToolHandlers(context = {}) {
  let pluginRegistry = resolvePluginRegistry(context);
  if (!pluginRegistry?.getTools)
    return {};

  let toolExecutor = resolveToolExecutor(context);
  let handlers = {};
  for (let [toolName, ToolClass] of pluginRegistry.getTools()) {
    if (!shouldExposeRegisteredTool(toolName, ToolClass))
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

function resolveToolExecutor(context = {}) {
  return context.toolExecutor
    || context.services?.toolExecutor
    || resolveService(context.services, 'toolExecutor')
    || new ToolExecutionService();
}

function shouldExposeRegisteredTool(toolName, ToolClass) {
  return typeof toolName === 'string'
    && toolName.trim() !== ''
    && AGENT_TOOL_NAME_PATTERN.test(toolName)
    && ToolClass?.exposeToAgents !== false;
}

function mergeToolDefinitions(primary, secondary) {
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

async function dispatchForwards(context, state) {
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
      message: forward.message,
    });
  }
}

function normalizeForwardTargets(target) {
  let values = Array.isArray(target) ? target : [ target ];
  let targets = [];

  for (let value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      targets.push(value.trim());
      continue;
    }

    if (value?.id && typeof value.id === 'string')
      targets.push(value.id.trim());
  }

  return targets.filter((targetValue, index) => targetValue && targets.indexOf(targetValue) === index);
}

function normalizeForwardRequest(target, message) {
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    return {
      targets: normalizeForwardTargets(target.targets || target.target || target.agentIDs || target.actorIDs),
      message: target.message || target.reason || message,
    };
  }

  return {
    targets: normalizeForwardTargets(target),
    message,
  };
}

function normalizeToolResponseContent(content) {
  if (typeof content === 'string')
    return { text: content };

  if (content && typeof content === 'object' && !Array.isArray(content))
    return { ...content };

  return { text: String(content ?? '') };
}

function normalizeReason(reason) {
  if (reason && typeof reason === 'object' && !Array.isArray(reason))
    return reason.reason || reason.message || '';

  return String(reason ?? '');
}

function readToolString(input, fieldNames) {
  if (typeof input === 'string')
    return input;

  if (!input || typeof input !== 'object' || Array.isArray(input))
    return '';

  for (let fieldName of fieldNames) {
    if (typeof input[fieldName] === 'string')
      return input[fieldName];
  }

  return '';
}

function normalizeRequiredToolString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeOptionalPromptString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTokenUsagePromptContext(context = {}) {
  let tokenUsage = (context.tokenUsage && typeof context.tokenUsage === 'object' && !Array.isArray(context.tokenUsage))
    ? context.tokenUsage
    : {};
  let total = Number(context.totalTokensUsed);
  if (!Number.isFinite(total) || total < 0)
    total = totalTokensUsed(tokenUsage);

  return {
    totalTokensUsed: Math.trunc(total),
    services: tokenUsage,
  };
}

function totalTokensUsed(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot || {})) {
    let value = Number(entry?.tokensUsed);
    if (Number.isFinite(value) && value > 0)
      total += Math.trunc(value);
  }

  return total;
}

function formatToolHelp(toolDefinitions) {
  return toolDefinitions
    .map((toolDefinition) => `- ${toolDefinition.name}: ${toolDefinition.help || toolDefinition.description || ''}`)
    .join('\n');
}

function buildRoutingPromptLines(context = {}) {
  if (context.isCoordinator === true) {
    let lines = [
      'If you are the coordinator, then you are the preferred agent. You evaluate first, and you are usually the best agent to answer broad, general, or ambiguous messages.',
      'Recipient decision checklist: ask "Who is this message really for: me, another session agent, the user, or everyone?" before answering.',
      'Use turn-taking: if the immediately prior visible response came from another agent and the user asks a follow-up with "you", "your", or a short ambiguous question, treat it as meant for that prior agent unless the user clearly redirects to you.',
      'If this message is not for you based on mentions, names, nicknames, turn-taking, or recent context, use agent-null-response and stay silent.',
      'Do not answer on behalf of another session agent just because you are the coordinator.',
      'Keep internal-forward available only for explicit forwarding workflows, such as external services or future sleeper agents; do not use it as normal intra-session handoff.',
      'If the message is targeted to you, deeply consider it in the context of the available user and project rules.',
    ];

    if (context.frame?.authorType === 'agent') {
      lines.splice(3, 0,
        'This is an agent-authored message in the shared session. Answer only if that agent directly asks you, mentions you, delegates to you, or your contribution is clearly needed.',
      );
    }

    return lines;
  }

  if (context.frame?.coordinated === true) {
    if (isCoordinatedMentionTarget(context)) {
      return [
        'You are not the coordinator. This frame has already been coordinated and forwarded to you.',
        'You are an intended recipient; answer if it is for you.',
        'If this message is not for you after checking mentions, names, turn-taking, and recent context, use agent-null-response and stay silent.',
        'Do not forward it again.',
      ];
    }

    return [
      'You are not the coordinator. This frame has already been coordinated and forwarded to its mentioned recipients.',
      'You are not an intended recipient. Use agent-null-response and do not forward it again.',
    ];
  }

  return [
    'You are not the coordinator. Answer only when the message is targeted to you.',
    'If this message is not for you, use agent-null-response and let routing continue elsewhere.',
  ];
}

function buildTriggerFramePromptLines(context = {}) {
  let frame = context.frame || {};
  if (frame.authorType === 'agent') {
    let label = normalizeOptionalPromptString(frame.authorDisplayName)
      || resolveParticipantName(context, frame.authorID)
      || normalizeOptionalPromptString(frame.authorID)
      || 'Unknown agent';
    let id = normalizeOptionalPromptString(frame.authorID);
    return [
      `Agent ${label}${id ? ` (${id})` : ''} has just sent a message:`,
    ];
  }

  if (frame.authorType === 'user')
    return [ 'The user has just sent you a message:' ];

  return [ 'A session frame has just been routed to you:' ];
}

function resolveParticipantName(context = {}, actorID = '') {
  let id = normalizeOptionalPromptString(actorID);
  if (!id)
    return '';

  for (let agent of normalizeParticipantAgents(context.participantAgents || context.sessionAgents, {
    participantAgentIDs: context.participantAgentIDs || context.session?.participantAgentIDs,
    coordinatorAgentID: context.coordinatorAgentID || context.session?.coordinatorAgentID,
    selfAgentID: context.agent?.id,
  })) {
    if (agent.id === id)
      return agent.name || '';
  }

  return '';
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolvePluginRegistry(context = {}) {
  if (context.pluginRegistry)
    return context.pluginRegistry;

  return resolveService(context.services, 'pluginRegistry');
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

function normalizeMentions(mentions) {
  if (!mentions || typeof mentions !== 'object' || Array.isArray(mentions))
    return {};

  return mentions;
}

function normalizeParticipantAgents(participantAgents, options = {}) {
  let participantAgentIDs = normalizeStringArray(options.participantAgentIDs);
  let coordinatorAgentID = normalizeOptionalPromptString(options.coordinatorAgentID);
  let selfAgentID = normalizeOptionalPromptString(options.selfAgentID);
  let byID = new Map();

  for (let participant of Array.isArray(participantAgents) ? participantAgents : []) {
    let id = normalizeOptionalPromptString(participant?.id || participant);
    if (!id)
      continue;

    byID.set(id, normalizeParticipantAgent(participant, {
      coordinatorAgentID,
      selfAgentID,
    }));
  }

  let orderedIDs = participantAgentIDs.slice();
  for (let id of byID.keys()) {
    if (!orderedIDs.includes(id))
      orderedIDs.push(id);
  }

  return orderedIDs.map((id) => byID.get(id) || normalizeParticipantAgent({ id }, {
    coordinatorAgentID,
    selfAgentID,
  }));
}

function normalizeParticipantAgent(agent, options = {}) {
  let id = normalizeOptionalPromptString(agent?.id || agent);
  let name = normalizeOptionalPromptString(agent?.name || agent?.displayName || id);
  let pluginID = normalizeOptionalPromptString(agent?.pluginID || agent?.pluginId);
  let item = {
    id,
    type: 'agent',
    name: name || id,
    isSelf: id === options.selfAgentID,
    isCoordinator: id === options.coordinatorAgentID,
  };

  if (pluginID)
    item.pluginID = pluginID;

  return item;
}

function isCoordinatedMentionTarget(context = {}) {
  if (context.frame?.coordinated !== true)
    return false;

  let agentID = normalizeOptionalPromptString(context.agent?.id);
  if (!agentID)
    return false;

  let mentions = normalizeMentions(context.mentions || context.frame?.mentions);
  return Object.prototype.hasOwnProperty.call(mentions, agentID);
}

async function *iterateAgentResult(value) {
  let resolved = await value;
  if (resolved == null)
    return;

  if (typeof resolved[Symbol.asyncIterator] === 'function') {
    for await (let item of resolved)
      yield item;
    return;
  }

  if (typeof resolved[Symbol.iterator] === 'function' && typeof resolved !== 'string') {
    for (let item of resolved)
      yield item;
    return;
  }

  yield resolved;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values))
    return [];

  let normalized = [];
  for (let value of values) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!normalized.includes(item))
      normalized.push(item);
  }

  return normalized;
}

function normalizeCoordinatorAgentID(coordinatorAgentID, participantAgentIDs) {
  if (typeof coordinatorAgentID === 'string') {
    let trimmed = coordinatorAgentID.trim();
    if (participantAgentIDs.includes(trimmed))
      return trimmed;
  }

  return participantAgentIDs[0] || null;
}

export function normalizeConfigFields(fields) {
  if (!Array.isArray(fields))
    return [];

  return fields
    .filter((field) => field?.name && typeof field.name === 'string')
    .map((field) => ({
      name: field.name,
      label: field.label || field.name,
      type: field.type || 'text',
      required: field.required === true,
      secret: field.secret === true,
      defaultValue: field.defaultValue,
      options: Array.isArray(field.options) ? field.options.slice() : undefined,
      help: field.help || '',
    }));
}
