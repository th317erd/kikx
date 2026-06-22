'use strict';

import { ToolExecutionService } from '../tools/tool-execution-service.mjs';
import {
  buildAgenticScriptPrompt,
  buildCompletionReviewScriptPrompt,
} from './agent-script-template.mjs';
import { PluginInterface } from './plugin-interface.mjs';

const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'agent-respond',
    description: 'Finalize this turn with a visible response from this agent after required work is complete.',
    help: 'Use agent-respond only after you have completed any needed tool work for this turn. Do not use it to announce future tool work.',
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
    name: 'agent-respond-and-continue',
    description: 'Finalize this turn with a visible response, then schedule a delayed continuation back to this same agent.',
    help: [
      'Use agent-respond-and-continue when you need to tell the user or other agents what you did now, then resume your own work at a scheduled time.',
      'This is a boomerang: your visible response ends this turn, and Kikx will route a hidden continuation frame back to you after delayMs.',
      'This is the proper tool for progress updates when you must continue the task yourself after reporting progress.',
      'Do not use this for ordinary final answers.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible response text for this turn.',
        },
        delayMs: {
          type: 'integer',
          description: 'Delay in milliseconds before this same agent receives a continuation frame. Defaults to 1000. May be 0 or any future delay.',
        },
        continuationPrompt: {
          type: 'string',
          description: 'Prompt text Kikx will send back to you when the timer fires. Defaults to "Please continue what you were doing."',
        },
      },
      required: [ 'text' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-finalize',
    description: 'Finalize this turn with a visible response from this agent after required work is complete.',
    help: 'Use agent-finalize as an explicit synonym for agent-respond after needed tool work is complete.',
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
    name: 'agent-progress',
    description: 'Write a visible, non-final progress note before using another tool.',
    help: [
      'Use agent-progress before every individual read, write, fetch, search, exec, or other task tool call.',
      'Keep the note short: one paragraph at most, describing the single next tool action you are about to take.',
      'Do not group several future tool calls under one progress note.',
      'This does not finalize your turn; continue with the tool call after the progress note succeeds.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible one-paragraph progress note for the single next tool action.',
        },
      },
      required: [ 'text' ],
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
const DELEGATION_TOOL_NAMES = new Set([ 'session-create', 'session-invite-agents' ]);
const REVIEW_ONLY_TOOL_DENYLIST = new Set([ 'write-file' ]);
const REVIEW_ONLY_AGENT_PATTERN = /\b(?:qa|q\.a\.|tester|quality|ux|user[-\s]?experience|designer|reviewer|security|product|coordinator)\b/i;
const AVOIDABLE_DEFERRAL_PATTERNS = [
  /\b(?:should|shall)\s+i\s+(?:continue|proceed|read|inspect|review|run|start|create|update|check|look|audit|test)\b/i,
  /\b(?:would|do)\s+you\s+(?:like|want)\s+me\s+to\b/i,
  /\bcan\s+i\s+proceed\b/i,
  /\bany\s+changes\b[\s\S]{0,120}\bbefore\s+i\s+proceed\b/i,
  /\bwhich\s+(?:would\s+you\s+like|one\s+should\s+i|option\s+should\s+i)\b/i,
  /\bplease\s+(?:tell|let)\s+me\s+which\b/i,
  /\bwhat\s+would\s+you\s+like\s+me\s+to\s+do\s+next\b/i,
  /\bbefore\s+i\s+(?:start|begin|proceed|change|edit|modify)[\s\S]{0,160}\b(?:please\s+)?(?:tell|let)\s+me\b/i,
  /\bi\s+will\s+only\s+proceed\s+after\s+your\s+confirmation\b/i,
  /\bif\s+yes,?\s+i\s+will\b/i,
];

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
      yield* this.runCompletionReview(context, state);
      applyAvoidableDeferralGuard(context, state);

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

      if (state.finalFrame && !state.yieldedAgentMessage)
        yield state.finalFrame;

      yield {
        type: 'Done',
        content: {
          status: state.continuation ? 'respond-and-continue' : 'finalized',
          ...(state.continuation ? { continuation: state.continuation } : {}),
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
        continue;
      }

      if (state.break || state.nullResponse || state.forwarded || state.finalized)
        continue;

      if (output?.type === 'AgentMessage' && output.phantom !== true) {
        state.finalized = true;
        state.finalFrame = output;
        yieldedOutput = true;
        continue;
      }

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

  async *runCompletionReview(context, state) {
    if (state.completionReviewed || !state.finalFrame || state.nullResponse || state.forwarded || this.ask === AgentInterface.prototype.ask)
      return;

    state.completionReviewed = true;
    let prompt = this.buildCompletionReviewPrompt(context, state);
    let step = {
      type: 'completion-review',
      prompt,
    };
    let tools = createLoopTools(state, context);
    let toolDefinitions = createLoopToolDefinitions(context);
    let reviewOriginalFinalFrame = state.finalFrame;
    let reviewStartFinalFrame = state.finalFrame;
    let result = this.ask(prompt, {
      ...context,
      tools,
      toolDefinitions,
      step,
      completionReview: true,
    });

    let reviewControlFinalized = false;
    for await (let output of iterateAgentResult(result)) {
      if (output?.type === 'LoopControl') {
        if (isCompletionReviewMetaResponseContent(output.content) && reviewOriginalFinalFrame) {
          state.finalFrame = reviewOriginalFinalFrame;
          state.continuation = null;
          continue;
        }

        reviewControlFinalized = output.action === 'finalize' || output.action === 'respond-and-continue';
        handleLoopControl(output, state);
        continue;
      }

      if (output?.type === 'AgentMessage') {
        if (isCompletionReviewMetaResponseContent(output.content) && reviewOriginalFinalFrame) {
          state.finalFrame = reviewOriginalFinalFrame;
          state.continuation = null;
          continue;
        }

        let responseToolSelectedFrame = reviewControlFinalized || state.finalFrame !== reviewStartFinalFrame;
        state.finalFrame = responseToolSelectedFrame
          ? mergeFinalizedProviderFrame(output, state.finalFrame)
          : mergeCompletionReviewFrame(state.finalFrame, output);
        reviewStartFinalFrame = state.finalFrame;
        continue;
      }

      if (output?.type === 'Done')
        continue;

      if (output?.type)
        yield output;
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
    let todoState = normalizeTodoPromptContext(context.todoState || context.todoList || context.todos);
    let cwdState = normalizeCwdPromptContext(context.cwdState || context.shellCwd || context.cwd);
    return buildAgenticScriptPrompt({
      frameMessage,
      mentions,
      participantAgents,
      character,
      tokenUsage,
      todoState,
      cwdState,
      sessionGeneration: sessionGeneration(context.session),
      isCoordinator: context.isCoordinator === true,
      triggerFrameLines: buildTriggerFramePromptLines(context),
      routingLines: buildRoutingPromptLines(context),
      toolDefinitions: createLoopToolDefinitions(context),
    });
  }

  buildCompletionReviewPrompt(context = {}, state = {}) {
    let frameMessage = context.frame?.content?.text || '';
    return buildCompletionReviewScriptPrompt({
      frameMessage,
      finalFrameContent: state.finalFrame?.content || {},
      toolDefinitions: createLoopToolDefinitions(context),
    });
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
    completionReviewed: false,
    finalFrame: null,
    continuation: null,
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
  let forward = (target, message) => {
    let forwardRequest = normalizeForwardRequest(target, message);
    recordForward(state, forwardRequest);
    return { type: 'LoopControl', action: 'forward', ...forwardRequest };
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

  if (toolName === 'agent-null-response' && isSoleAgentUserTurn(context))
    return false;

  return true;
}

function isSoleAgentUserTurn(context = {}) {
  let participantAgentIDs = normalizeStringArray(context.participantAgentIDs || context.session?.participantAgentIDs);
  let frame = context.frame || {};

  return participantAgentIDs.length <= 1
    && frame.authorType === 'user'
    && frame.hidden !== true
    && frame.deleted !== true;
}

function handleLoopControl(output, state) {
  if (!output || output.type !== 'LoopControl')
    return false;

  if (output.action === 'finalize') {
    state.finalized = true;
    state.continuation = null;
    state.finalFrame = {
      type: 'AgentMessage',
      content: normalizeToolResponseContent(output.content),
    };
    return true;
  }

  if (output.action === 'respond-and-continue') {
    state.finalized = true;
    state.continuation = normalizeContinuationRequest(output.continuation || output.content);
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

function mergeCompletionReviewFrame(finalFrame, reviewFrame) {
  if (!reviewFrame?.content)
    return finalFrame;

  return {
    ...(finalFrame || {}),
    ...reviewFrame,
    content: {
      ...(finalFrame?.content && typeof finalFrame.content === 'object' && !Array.isArray(finalFrame.content)
        ? finalFrame.content
        : {}),
      ...(reviewFrame.content && typeof reviewFrame.content === 'object' && !Array.isArray(reviewFrame.content)
        ? reviewFrame.content
        : {}),
    },
  };
}

function applyAvoidableDeferralGuard(context = {}, state = {}) {
  if (state.continuation || !state.finalFrame?.content || !isVisibleUserTurn(context))
    return;

  let text = finalFrameText(state.finalFrame);
  if (!isAvoidableDeferralQuestion(text))
    return;

  state.continuation = {
    delayMs: 0,
    continuationPrompt: [
      'Your previous draft stopped to ask the user whether to continue or which obvious safe next step to take.',
      'The user expects you to infer the next safe implied step and continue without asking for permission.',
      'Continue now. Use tools if needed. Ask only if there is a real blocker, a destructive/risky action, or a genuinely important decision that cannot be inferred.',
    ].join(' '),
  };
  state.finalFrame = {
    ...state.finalFrame,
    content: {
      ...state.finalFrame.content,
      text: 'I’m going to continue with the next safe implied step instead of stopping for confirmation.',
    },
  };
}

function isVisibleUserTurn(context = {}) {
  let frame = context.frame || {};
  return frame.authorType === 'user'
    && frame.hidden !== true
    && frame.deleted !== true;
}

function finalFrameText(frame) {
  let content = frame?.content || {};
  return normalizeOptionalPromptString(content.text || content.markdown || content.html);
}

function isAvoidableDeferralQuestion(text) {
  let value = normalizeOptionalPromptString(text);
  if (!value)
    return false;

  return AVOIDABLE_DEFERRAL_PATTERNS.some((pattern) => pattern.test(value));
}

function isCompletionReviewMetaResponseContent(content = {}) {
  let text = normalizeOptionalPromptString(content.text || content.markdown || content.html);
  if (!text)
    return false;

  let prefix = text.slice(0, 240).toLowerCase();
  return (
    prefix.includes('self-review')
    || prefix.includes('self review')
    || prefix.includes('completion self-review')
    || prefix.includes('audit of the draft')
  )
    && /(?:have i completed|what did i miss|what did i forget|what could i have done better|requested tasks)/i.test(text);
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

async function recordAgentProgress(input, context = {}) {
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

function resolveFrameEngine(context = {}) {
  return context.frameEngine
    || context.services?.frameEngine
    || resolveService(context.services, 'frameEngine');
}

function resolveClock(context = {}) {
  if (typeof context.services?.clock === 'function')
    return context.services.clock;

  if (typeof context.clock === 'function')
    return context.clock;

  return () => Date.now();
}

function createRegisteredToolDefinitions(context = {}) {
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

function withCrossSessionToolParameter(schema) {
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

function createRegisteredToolHandlers(context = {}) {
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

function resolveToolExecutor(context = {}) {
  return context.toolExecutor
    || context.services?.toolExecutor
    || resolveService(context.services, 'toolExecutor')
    || new ToolExecutionService();
}

function shouldExposeRegisteredTool(toolName, ToolClass, context = {}) {
  return typeof toolName === 'string'
    && toolName.trim() !== ''
    && AGENT_TOOL_NAME_PATTERN.test(toolName)
    && ToolClass?.exposeToAgents !== false
    && shouldExposeDelegationTool(toolName, context)
    && shouldExposeRoleTool(toolName, context);
}

function shouldExposeDelegationTool(toolName, context = {}) {
  if (!DELEGATION_TOOL_NAMES.has(toolName))
    return true;

  return sessionGeneration(context.session) <= 0;
}

function shouldExposeRoleTool(toolName, context = {}) {
  if (!REVIEW_ONLY_TOOL_DENYLIST.has(toolName))
    return true;

  if (hasExplicitWriteFilePermission(context))
    return true;

  return !isReviewOnlyAgent(context.agent);
}

function hasExplicitWriteFilePermission(context = {}) {
  return context.allowWriteFile === true
    || context.agent?.allowWriteFile === true
    || context.agent?.permissions?.writeFile === true
    || context.agent?.config?.allowWriteFile === true
    || context.agent?.config?.permissions?.writeFile === true;
}

function isReviewOnlyAgent(agent = {}) {
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

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    let {
      delayMs: _delayMs,
      delayMS: _delayMS,
      delayMilliseconds: _delayMilliseconds,
      delaySeconds: _delaySeconds,
      seconds: _seconds,
      continuationPrompt: _continuationPrompt,
      prompt: _prompt,
      reason: _reason,
      ...rest
    } = content;
    return { ...rest };
  }

  return { text: String(content ?? '') };
}

function normalizeContinuationRequest(input) {
  let payload = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  return {
    delayMs: normalizeContinuationDelay(payload.delayMs ?? payload.delayMS ?? payload.delayMilliseconds ?? secondsToMs(payload.delaySeconds ?? payload.seconds)),
    continuationPrompt: normalizeReason(payload.continuationPrompt || payload.prompt || payload.reason || 'Please continue what you were doing.'),
  };
}

function secondsToMs(value) {
  if (value == null || value === '')
    return null;

  let number = Number(value);
  if (!Number.isFinite(number))
    return value;

  return number * 1000;
}

function normalizeContinuationDelay(value) {
  if (value == null || value === '')
    return 1000;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new TypeError('delayMs must be a non-negative finite number');

  return Math.trunc(number);
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

function sessionGeneration(session) {
  if (!session || typeof session !== 'object')
    return 0;

  let number = Number(session.generation);
  if (Number.isFinite(number) && number >= 0)
    return Math.trunc(number);

  return session.parentSessionID ? 1 : 0;
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

function normalizeTodoPromptContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  return {
    agentID: typeof value.agentID === 'string' ? value.agentID : null,
    items: Array.isArray(value.items) ? value.items : [],
    focus: value.focus && typeof value.focus === 'object' && !Array.isArray(value.focus)
      ? value.focus
      : null,
    updatedAt: value.updatedAt || null,
  };
}

function normalizeCwdPromptContext(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    return {
      cwd: value.trim(),
      configured: true,
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  return {
    cwd: typeof value.cwd === 'string' ? value.cwd.trim() : '',
    configured: value.configured === true,
    updatedAt: value.updatedAt || null,
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
  if (frame.continuation?.kind === 'agent-respond-and-continue' || frame.authorID === 'internal:agent-continuation') {
    return [
      'Your scheduled respond-and-continue prompt has fired and this hidden continuation frame has been routed back to you:',
    ];
  }

  if (frame.continuation?.kind === 'exec-wake-on-completion' || frame.authorID === 'internal:process-manager') {
    return [
      'An async process you started has completed and this hidden completion wake frame has been routed back to you:',
    ];
  }

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

  if (frame.authorType === 'user') {
    let label = normalizeOptionalPromptString(frame.authorDisplayName)
      || normalizeOptionalPromptString(frame.authorID);
    return [
      label ? `User ${label} has just sent you a message:` : 'The user has just sent you a message:',
    ];
  }

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
