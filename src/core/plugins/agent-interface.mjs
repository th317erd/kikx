'use strict';

import {
  buildAgenticScriptPrompt,
  buildCompletionReviewScriptPrompt,
} from './agent-script-template.mjs';
import {
  iterateAgentResult,
  normalizeCoordinatorAgentID,
  normalizeConfigFields,
  normalizeOptionalPromptString,
  normalizeStringArray,
  normalizeToolResponseContent,
  sessionGeneration,
} from './agent-normalizers.mjs';
import {
  normalizeMentions,
  normalizeParticipantAgents,
} from './agent-participants.mjs';
import {
  buildRoutingPromptLines,
  buildTriggerFramePromptLines,
  normalizeCwdPromptContext,
  normalizeTodoPromptContext,
  normalizeTokenUsagePromptContext,
} from './agent-prompt-context.mjs';
import {
  applyAvoidableDeferralGuard,
  buildLoopDoneContent,
  captureProviderDoneUsage,
  createLoopState,
  handleLoopControl,
  isCompletionReviewMetaResponseContent,
  isInternalStreamingOutput,
  mergeCompletionReviewFrame,
  mergeFinalizedProviderFrame,
} from './agent-loop-state.mjs';
import {
  createLoopToolDefinitions,
  createLoopTools,
  dispatchForwards,
} from './agent-loop-tools.mjs';
import {
  SESSION_SYSTEM_PROMPT,
  buildModelMessages,
  frameToModelTurn,
  resolvePromptContent,
} from './agent-model-context.mjs';
import { PluginInterface } from './plugin-interface.mjs';

export { normalizeConfigFields } from './agent-normalizers.mjs';

export class AgentInterface extends PluginInterface {
  static agentType = null;
  static serviceType = null;
  static configFields = [];
  static maxLoopSteps = 8;

  // Shared frame -> model turn projection. Providers use these so a new core
  // frame type is handled once rather than silently dropped by each adapter.
  static SESSION_SYSTEM_PROMPT = SESSION_SYSTEM_PROMPT;

  static frameToModelTurn(frame, options) {
    return frameToModelTurn(frame, options);
  }

  static buildModelMessages(params, options) {
    return buildModelMessages(params, options);
  }

  static resolvePromptContent(params) {
    return resolvePromptContent(params);
  }

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
        content: buildLoopDoneContent(state, { status: 'null-response' }),
      };
      return;
    }

    if (state.forwarded) {
      yield {
        type: 'Done',
        content: buildLoopDoneContent(state, { status: 'forwarded' }),
      };
      return;
    }

    if (state.finalized) {
      yield* this.runCompletionReview(context, state);
      applyAvoidableDeferralGuard(context, state);

      if (state.nullResponse) {
        yield {
          type: 'Done',
          content: buildLoopDoneContent(state, { status: 'null-response' }),
        };
        return;
      }

      if (state.forwarded) {
        yield {
          type: 'Done',
          content: buildLoopDoneContent(state, { status: 'forwarded' }),
        };
        return;
      }

      if (state.finalFrame && !state.yieldedAgentMessage)
        yield state.finalFrame;

      yield {
        type: 'Done',
        content: buildLoopDoneContent(state, {
          status: state.continuation ? 'respond-and-continue' : 'finalized',
          ...(state.continuation ? { continuation: state.continuation } : {}),
        }),
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

      captureProviderDoneUsage(state, output);

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
      if (isInternalStreamingOutput(output))
        continue;

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

      if (output?.type === 'Done') {
        captureProviderDoneUsage(state, output);
        continue;
      }

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

  static async getAgentProviderDescriptor() {
    let pluginID = (this.pluginID && this.pluginID !== 'unknown') ? this.pluginID : this.pluginId;
    return {
      pluginID,
      agentType: this.agentType || pluginID,
      serviceType: this.serviceType || null,
      displayName: this.displayName || pluginID,
      description: this.description || '',
      configFields: normalizeConfigFields(await this.resolveConfigFields()),
    };
  }

  static async resolveConfigFields() {
    return this.configFields;
  }
}
