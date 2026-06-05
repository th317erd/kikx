'use strict';

import { PluginInterface } from './plugin-interface.mjs';

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
      if (state.break || state.nullResponse || state.finalized)
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
    let tools = createLoopTools(state);
    let yieldedOutput = false;
    let result = this.ask(step.prompt || this.buildDefaultAgentPrompt(context), {
      ...context,
      tools,
      step,
    });

    for await (let output of iterateAgentResult(result)) {
      if (handleLoopControl(output, state))
        continue;

      if (state.break || state.nullResponse || state.finalized)
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
    let userMessage = context.frame?.content?.text || '';
    return [
      'The user has just sent you a message:',
      '',
      userMessage,
      '',
      `You are the coordinator?: ${context.isCoordinator === true}`,
      '',
      'If you are the coordinator, then you are the preferred agent. You are the first to talk and respond, and you get to decide how to direct this message.',
      'If it is meant for another party, use the forward tool.',
      'If the message is targeted to you, deeply consider it in the context of the available user and project rules.',
      'When you are ready to answer, use the respond/finalize tool or return a final agent message.',
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
    finalFrame: null,
    yieldedAgentMessage: false,
    forwards: [],
  };
}

function createLoopTools(state) {
  return {
    respond(content) {
      state.finalized = true;
      state.finalFrame = {
        type: 'AgentMessage',
        content: normalizeToolResponseContent(content),
      };
      return { type: 'LoopControl', action: 'finalize', content: state.finalFrame.content };
    },
    finalize(content) {
      state.finalized = true;
      state.finalFrame = {
        type: 'AgentMessage',
        content: normalizeToolResponseContent(content),
      };
      return { type: 'LoopControl', action: 'finalize', content: state.finalFrame.content };
    },
    nullResponse(reason = '') {
      state.nullResponse = true;
      return { type: 'LoopControl', action: 'null-response', reason };
    },
    forward(target, message) {
      let forward = { target, message };
      state.forwards.push(forward);
      return { type: 'LoopControl', action: 'forward', ...forward };
    },
    break(reason = '') {
      state.break = true;
      return { type: 'LoopControl', action: 'break', reason };
    },
  };
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
    state.forwards.push({
      target: output.target,
      message: output.message,
    });
    return true;
  }

  return false;
}

function normalizeToolResponseContent(content) {
  if (typeof content === 'string')
    return { text: content };

  if (content && typeof content === 'object' && !Array.isArray(content))
    return { ...content };

  return { text: String(content ?? '') };
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
