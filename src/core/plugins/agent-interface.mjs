'use strict';

import {
  buildCompletionReviewScriptPrompt,
  buildMessageBrief,
  buildStartBrief,
} from './agent-script-template.mjs';
import {
  budgetForModel,
  estimateTokens,
  fitMessagesToBudget,
} from './agent-context-budget.mjs';
import {
  iterateAgentResult,
  normalizeCoordinatorAgentID,
  normalizeConfigFields,
  normalizeStringArray,
  normalizeToolResponseContent,
} from './agent-normalizers.mjs';
import {
  normalizeParticipantAgents,
} from './agent-participants.mjs';
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
  // Output reserve used when deciding whether a completion self-review request
  // can fit the model window at all.
  static reviewOutputReserveTokens = 1024;

  // Shared frame -> model turn projection. Providers use these so a new core
  // frame type is handled once rather than silently dropped by each adapter.
  static SESSION_SYSTEM_PROMPT = SESSION_SYSTEM_PROMPT;

  // Model-aware context budgeting, exposed to providers that build their own
  // request payloads (for example the Codex plugin) so they do not duplicate
  // the estimation/trimming logic.
  static estimateTokens(text) {
    return estimateTokens(text);
  }

  static budgetForModel(options) {
    return budgetForModel(options);
  }

  static fitMessagesToBudget(messages, options) {
    return fitMessagesToBudget(messages, options);
  }

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

      // The avoidable-deferral guard suppresses a stalling draft: the agent will
      // answer via its immediate continuation instead, so no visible frame is
      // emitted this turn (and the placeholder must not dangle).
      if (state.suppressFinalFrame) {
        yield { type: 'SuppressFinalFrame' };
      } else if (state.finalFrame && !state.yieldedAgentMessage) {
        yield state.finalFrame;
      }

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

  createAgentLoopScript(_context = {}) {
    // The default loop is a single ask. The per-turn message text is derived
    // from the trigger frame in `executeAskStep`; the model-facing prompt shape
    // (Brief A once + Brief B every turn) is assembled by `buildModelMessages`.
    return [{ type: 'ask' }];
  }

  async *executeAskStep(step, context, state) {
    let tools = createLoopTools(state, context);
    let toolDefinitions = createLoopToolDefinitions(context);
    let yieldedOutput = false;
    // Pass the raw message text (not a pre-built prompt); providers expose it as
    // `params.prompt` and `buildModelMessages` wraps it in the message brief. Keep
    // a non-empty fallback so providers never reject an empty prompt for a routed
    // frame that happens to carry no text (the old monolith always had boilerplate).
    let messageText = step.prompt || context.frame?.content?.text || 'Please continue what you were doing.';
    let result = this.ask(messageText, {
      ...context,
      prompt: step.prompt || null,
      rawPrompt: step.rawPrompt === true,
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
    // Skip a doomed review request: if the (already capped) review prompt alone
    // cannot fit the model window, finalize directly instead of sending a
    // request that will be rejected. Models with ample room are unaffected.
    if (!this.canFitCompletionReview(context, prompt))
      return;

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

  // Instance wrappers around the pure two-tier builders so tests and providers
  // can assemble either brief directly. These are the model-facing API.
  buildStartBrief(context = {}) {
    return buildStartBrief(context);
  }

  buildMessageBrief(context = {}) {
    return buildMessageBrief(context);
  }

  // The model's context window: from the model manifest first, then from an
  // explicit `config.contextWindowTokens` override. Returns null when unknown.
  resolveContextWindow(context = {}) {
    let modelID = context.config?.model;
    let fromModel = this.contextWindowFor(modelID);
    if (Number.isFinite(fromModel) && fromModel > 0)
      return fromModel;

    let configured = Number(context.config?.contextWindowTokens);
    return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : null;
  }

  // Whether a completion self-review prompt can fit the model window. Unknown
  // windows are treated as fitting so large/opaque models keep their review.
  canFitCompletionReview(context = {}, prompt = '') {
    let window = this.resolveContextWindow(context);
    if (!Number.isFinite(window) || window <= 0)
      return true;

    let reserve = Number(this.constructor.reviewOutputReserveTokens);
    let budget = budgetForModel({
      contextWindow: window,
      maxOutputTokens: Number.isFinite(reserve) && reserve > 0 ? reserve : 0,
    });
    return estimateTokens(prompt) <= budget;
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

  // Resolve the provider's config fields. Providers may override this to make
  // fields dynamic (for example, populating a model list from the configured
  // server). `context` carries the in-progress `{ config, secrets }` so a
  // provider can discover options for a not-yet-saved configuration.
  static async resolveConfigFields(_context = {}) {
    return this.configFields;
  }

  // Optional provider hook for provider-specific validation that cannot be
  // expressed with static `required` flags on config fields. Called by
  // AgentManager while creating an agent, after generic field validation. A
  // provider may throw (or reject) to reject the input. Default: no-op.
  static async validateCreateAgent() {}

  // Model manifest. Providers override this with their available models so the
  // system can aggregate a catalog (see AgentManager.listModels) for model
  // selection and model-aware token budgeting. Descriptor fields:
  //   { id, contextWindow, maxOutputTokens, displayName, description,
  //     pricePerToken, useWhen }
  static getModels() {
    return [];
  }

  // Rough token estimate for a block of text. Providers may override with a
  // more accurate tokenizer.
  estimateTokens(text) {
    let value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
    return Math.max(1, Math.ceil(value.length / 4));
  }

  // Context-window size for a model id, from the provider's manifest.
  contextWindowFor(modelID) {
    let models = this.constructor.getModels();
    let match = models.find((model) => model.id === modelID) || models[0];
    return match?.contextWindow || null;
  }

  // Whether the provider wants to compact given token statistics.
  shouldCompact() {
    return { compact: false, reason: '' };
  }

  // Max tokens the compaction summary may consume.
  getMaxCompactionTokens() {
    return 8000;
  }
}
