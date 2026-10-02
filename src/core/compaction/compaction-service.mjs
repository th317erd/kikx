'use strict';

import { randomUUID } from 'node:crypto';

import { AgentInterface } from '../plugins/agent-interface.mjs';
import {
  buildAgentCompactionPrompt,
  buildDefaultCompactionInstructions,
} from './agent-compaction-template.mjs';
import { buildCompactionFrame, buildCompactionFrameUpdate } from './compaction-frame.mjs';
import { buildCompactionSummaryJSON } from './compaction-summary.mjs';
import {
  DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS,
  computeCompactionBudget,
  countCompactionMetadataTokens,
  resolveCompactorWindow,
} from './compaction-budget.mjs';
import { runChunkedCompaction } from './chunked-compaction.mjs';
import { resolveCompactionAgent as resolveCompactionAgentForSession } from './compactor-resolver.mjs';
import { resolveEffectiveContextWindow, resolveSessionWindows } from './effective-windows.mjs';
import {
  FrameContextBuilder,
  serializeFramesForCompaction,
} from './frame-context-builder.mjs';
import { buildRetryWindow } from './retry-window.mjs';
import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_COMPACTION_AGENT_CONTEXT_TOKENS = 128000;
const DEFAULT_PROMPT_RESERVE_TOKENS = 8000;
const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.7;
const DEFAULT_HARD_LIMIT_RATIO = 1;

export class CompactionService {
  constructor(options = {}) {
    this.agentManager = options.agentManager || null;
    this.pluginRegistry = options.pluginRegistry || null;
    this.frameRuntime = options.frameRuntime || null;
    this.clock = options.clock || (() => Date.now());
    this.idGenerator = options.idGenerator || (() => randomUUID());
    this.logger = options.logger || console;
    this.compactionAgentID = normalizeOptionalString(options.compactionAgentID || process.env.KIKX_COMPACTION_AGENT_ID);
    this.contextWindowTokens = normalizePositiveInteger(options.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS);
    this.compactionAgentContextTokens = normalizePositiveInteger(options.compactionAgentContextTokens, DEFAULT_COMPACTION_AGENT_CONTEXT_TOKENS);
    this.promptReserveTokens = normalizeNonNegativeInteger(options.promptReserveTokens, DEFAULT_PROMPT_RESERVE_TOKENS);
    this.baseReserveTokens = normalizeNonNegativeInteger(options.baseReserveTokens, this.promptReserveTokens);
    // R2/R4: room the compactor's own completion needs, subtracted from its
    // window before the serialized input is sized.
    this.compactionOutputReserveTokens = normalizeNonNegativeInteger(
      options.compactionOutputReserveTokens,
      DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS,
    );
    // Non-history overhead (system + start brief + current message + tools). When
    // unknown it stays 0: the estimate is never silently inflated (R2).
    this.usageOverheadTokens = normalizeNonNegativeInteger(options.usageOverheadTokens, 0);
    this.compactionTriggerRatio = normalizeRatio(options.compactionTriggerRatio, DEFAULT_COMPACTION_TRIGGER_RATIO);
    this.hardLimitRatio = normalizeRatio(options.hardLimitRatio, DEFAULT_HARD_LIMIT_RATIO);
    this.instructions = options.instructions || buildDefaultCompactionInstructions();
    this.contextBuilder = options.contextBuilder || new FrameContextBuilder({
      contextWindowTokens: this.contextWindowTokens,
      baseReserveTokens: this.baseReserveTokens,
      promptReserveTokens: this.promptReserveTokens,
      compactionTriggerRatio: this.compactionTriggerRatio,
      hardLimitRatio: this.hardLimitRatio,
      estimateTokens: options.estimateTokens,
    });
    this.pendingCompactions = new Map();
  }

  async prepareAgentContext(input = {}) {
    let frameEngine = input.frameEngine;
    let frames = projectFrameMessages(typeof frameEngine?.toArray === 'function' ? frameEngine.toArray() : input.frames || []);
    let triggerOptions = await this.resolveTriggerOptions(input);
    let result = this.contextBuilder.build(frames, {
      activeFrameID: input.triggerFrame?.id || input.activeFrameID,
      ...triggerOptions,
      compactionContextBudgetTokens: Math.max(1, this.compactionAgentContextTokens - this.countInstructionTokens()),
      compactionTriggerRatio: input.compactionTriggerRatio || this.compactionTriggerRatio,
      hardLimitRatio: input.hardLimitRatio || this.hardLimitRatio,
    });

    if (!result.shouldCompact)
      return result;

    let pending = this.startCompaction({
      ...input,
      frameEngine,
      compactionWindow: result.compactionWindow,
    });

    // R5: hold a bot awaiting an in-flight compaction only when the context it
    // would actually send exceeds ITS OWN window. Bots that still fit proceed.
    // The trigger uses the session's smallest window, so this bot's own window
    // must be resolved separately.
    //
    // Fail-safe: resolving the per-bot hold decision touches the agent manager,
    // constructs the agent's provider and reads its context window, any of which
    // can throw (missing agent, throwing provider constructor, throwing catalog).
    // A failure here must NEVER propagate out of `prepareAgentContext` and break
    // the agent's turn. Log it and fall back to the legacy hard-limit wait.
    let holdForCompaction = result.shouldWaitForCompaction === true;
    try {
      holdForCompaction = await this.shouldHoldAgentForCompaction(input, result);
    } catch (error) {
      this.logger.error?.('Kikx compaction hold decision failed; falling back to legacy wait', error);
    }

    if (pending && holdForCompaction) {
      await pending.catch((error) => {
        this.logger.error?.('Kikx compaction failed while waiting at hard context limit', error);
      });

      let nextFrames = projectFrameMessages(typeof frameEngine?.toArray === 'function' ? frameEngine.toArray() : frames);
      let rebuilt = this.contextBuilder.build(nextFrames, {
        activeFrameID: input.triggerFrame?.id || input.activeFrameID,
        ...triggerOptions,
        compactionContextBudgetTokens: Math.max(1, this.compactionAgentContextTokens - this.countInstructionTokens()),
        compactionTriggerRatio: input.compactionTriggerRatio || this.compactionTriggerRatio,
        hardLimitRatio: input.hardLimitRatio || this.hardLimitRatio,
      });
      // This bot waited for the in-flight compaction because its own window was
      // exceeded (R5); the rebuilt context reflects the new compaction frame.
      return { ...rebuilt, compactionPending: false, heldForCompaction: true };
    }

    return {
      ...result,
      compactionPending: true,
    };
  }

  // Whether the current agent must wait for the in-flight compaction because its
  // own projected context exceeds its own window (R5). Unknown windows keep the
  // legacy behavior: wait only at the hard limit.
  async shouldHoldAgentForCompaction(input = {}, result = {}) {
    let agentID = input.agent?.id || null;
    if (!agentID)
      return result.shouldWaitForCompaction === true;

    let agentManager = this.agentManager || resolveService(input.services, 'agentManager');
    let pluginRegistry = this.pluginRegistry || resolveService(input.services, 'pluginRegistry');
    let catalog = input.catalog || this.catalog || agentManager?.listModels?.() || [];
    let agent = input.agent;
    try {
      if (agentManager?.getAgent && (!agent || agent.config == null))
        agent = await agentManager.getAgent(agentID, { includeSecrets: false });
    } catch (_error) {
      agent = input.agent;
    }

    let providerClass = pluginRegistry?.getAgentProvider?.(agent?.pluginID) || null;
    let ownWindow;
    try {
      let provider = providerClass
        ? new providerClass({ ...(input.routerContext || {}), agent, services: input.services || {} })
        : null;
      ownWindow = provider?.resolveContextWindow?.({ config: agent?.config || {} });
    } catch (_error) {
      ownWindow = null;
    }
    if (!Number.isFinite(ownWindow) || ownWindow <= 0)
      ownWindow = resolveEffectiveContextWindow({ agent, providerClass, catalog });

    let baseReserveTokens = normalizeNonNegativeInteger(input.baseReserveTokens, this.baseReserveTokens);
    let ownHardLimit = Math.max(1, ownWindow - baseReserveTokens);
    return (result.contextTokens || 0) >= ownHardLimit;
  }

  // P0: the trigger follows the SMALLEST participant window (R1) and counts the
  // full projected request (R2). An explicit `input.agentContextWindowTokens`
  // wins (tests, callers with a known window); otherwise the session's effective
  // windows are resolved. When nothing resolves, the builder's global default is
  // preserved.
  async resolveTriggerOptions(input = {}) {
    // Explicit overrides win: the new per-agent option, then the legacy
    // `contextWindowTokens`. Otherwise resolve the session's smallest window.
    let agentContextWindowTokens = normalizePositiveInteger(input.agentContextWindowTokens)
      || normalizePositiveInteger(input.contextWindowTokens);
    if (agentContextWindowTokens == null) {
      // Fail-safe: window resolution loads every participant through the agent
      // manager (which can reject), reads the catalog and probes providers. Any
      // failure here must not break the agent's turn, so fall back to the legacy
      // global window instead of throwing out of `prepareAgentContext`.
      try {
        let agentManager = this.agentManager || resolveService(input.services, 'agentManager');
        let pluginRegistry = this.pluginRegistry || resolveService(input.services, 'pluginRegistry');
        let session = input.session || resolveService(input.services, 'session');
        let catalog = input.catalog || this.catalog || agentManager?.listModels?.() || [];
        let resolved = await resolveSessionWindows({
          session,
          agentManager,
          pluginRegistry,
          catalog,
        });
        agentContextWindowTokens = resolved.smallestWindow || null;
      } catch (error) {
        this.logger.error?.('Kikx compaction window resolution failed; using legacy global window', error);
        agentContextWindowTokens = null;
      }
    }

    // Preserve an explicit reserve override, else fall back to the legacy
    // `promptReserveTokens` option name.
    let baseReserveTokens = normalizeNonNegativeInteger(
      input.baseReserveTokens,
      normalizeNonNegativeInteger(input.promptReserveTokens),
    );

    return {
      agentContextWindowTokens: agentContextWindowTokens || this.contextWindowTokens,
      usageOverheadTokens: normalizeNonNegativeInteger(input.usageOverheadTokens, this.usageOverheadTokens),
      ...(baseReserveTokens != null ? { baseReserveTokens } : {}),
    };
  }

  startCompaction(input = {}) {
    let sessionID = input.session?.id || input.sessionID || input.triggerFrame?.sessionID;
    let boundaryFrameID = input.compactionWindow?.boundaryFrameID;
    if (!sessionID || !boundaryFrameID || !input.frameEngine)
      return null;

    let key = `${sessionID}:${boundaryFrameID}`;
    let existing = this.pendingCompactions.get(key);
    if (existing)
      return existing.promise;

    let promise = this.runCompaction(input)
      .then((frame) => {
        this.emitCompactionEvent('compaction.completed', {
          sessionID,
          boundaryFrameID,
          frame,
          compactionFrameID: frame?.id || null,
        });
        return frame;
      })
      .catch(async (error) => {
        // P7 failure -> trim fallback. Never delete frames and never return a
        // bare null: write a VISIBLE boundary compaction frame with status
        // `trimmed`, no summary, and the failure recorded as warnings/errors, so
        // the requesting bot's projection starts after it and it has room.
        this.logger.error?.('Kikx async compaction failed; trimming context to proceed', error);
        let trimmedFrame = this.writeTrimmedBoundary(input, error);
        await this.flushFrameStores(input.services);
        this.emitCompactionEvent('compaction.failed', {
          sessionID,
          boundaryFrameID,
          compactionFrameID: trimmedFrame?.id || null,
          error: {
            message: error?.message || 'Compaction failed',
          },
        });
        this.emitCompactionEvent('compaction.trimmed', {
          sessionID,
          boundaryFrameID,
          frame: trimmedFrame,
          compactionFrameID: trimmedFrame?.id || null,
          warning: 'Compaction failed; context was trimmed to proceed.',
        });
        return trimmedFrame;
      })
      .finally(() => {
        this.pendingCompactions.delete(key);
      });

    this.pendingCompactions.set(key, { promise, sessionID, boundaryFrameID });
    this.emitCompactionEvent('compaction.started', {
      sessionID,
      boundaryFrameID,
      frameCount: input.compactionWindow.frames.length,
    });
    return promise;
  }

  // P8 (ruling Q3): re-run compaction for the SAME boundary a prior frame used.
  // Frames are immutable history — the stored `frameIDs` still exist, so the
  // window is rebuilt from the frame's metadata, not re-selected. The compactor
  // and its window are recomputed from the CURRENT session (a newly joined
  // smaller bot must change the effective window). The result overwrites the
  // SAME frame id via `runCompaction`/`writeTrimmedBoundary`; it is never a bare
  // null and the original boundary metadata is restored on the overwritten frame.
  async retryCompaction({ session, frameEngine, compactionFrameID, services, ...input } = {}) {
    if (!compactionFrameID || typeof frameEngine?.get !== 'function')
      throw new Error('Retry compaction requires a compaction frame id and frame engine');

    let existing = frameEngine.get(compactionFrameID);
    if (!existing)
      throw new Error(`Unknown compaction frame: ${compactionFrameID}`);

    let compactionWindow = buildRetryWindow(existing, frameEngine);
    if (!compactionWindow)
      return existing;

    let retryInput = {
      ...input,
      session,
      frameEngine,
      compactionWindow,
      compactionFrameID,
      services: services || input.services || {},
    };

    return await this.startCompaction(retryInput);
  }

  startManualCompaction(input = {}) {
    let session = input.session;
    let frameEngine = input.frameEngine;
    if (!session?.id || !frameEngine)
      throw new Error('Manual compaction requires a session and frame engine');

    let frames = projectFrameMessages(typeof frameEngine.toArray === 'function' ? frameEngine.toArray() : input.frames || []);
    let context = this.contextBuilder.build(frames, {
      activeFrameID: input.triggerFrame?.id || input.activeFrameID,
      contextWindowTokens: Number.MAX_SAFE_INTEGER,
      promptReserveTokens: 0,
      compactionContextBudgetTokens: Math.max(1, this.compactionAgentContextTokens - this.countInstructionTokens()),
      compactionTriggerRatio: 1,
      hardLimitRatio: 1,
    });
    let compactionWindow = context.compactionWindow;
    let runningFrame = this.createCompactionFrame({
      session,
      compactorAgent: input.agent || null,
      compactionWindow,
      summary: '',
      status: compactionWindow.frames.length > 0 ? 'running' : 'complete',
      hidden: false,
      manual: true,
      requestedByFrameID: input.triggerFrame?.id || null,
      message: compactionWindow.frames.length > 0
        ? 'Compacting session context...'
        : 'Nothing to compact.',
    });

    let merged = frameEngine.merge([ runningFrame ], {
      authorType: 'system',
      authorID: 'internal:compaction',
    });
    let visibleFrame = merged[0] || frameEngine.get(runningFrame.id) || runningFrame;
    void this.flushFrameStores(input.services).catch((error) => {
      this.logger.error?.('Kikx manual compaction failed to flush running frame', error);
    });

    if (compactionWindow.frames.length === 0) {
      this.emitCompactionEvent('compaction.completed', {
        sessionID: session.id,
        boundaryFrameID: null,
        frame: visibleFrame,
        compactionFrameID: visibleFrame.id,
        manual: true,
      });
      return Promise.resolve(visibleFrame);
    }

    this.emitCompactionEvent('compaction.started', {
      sessionID: session.id,
      boundaryFrameID: compactionWindow.boundaryFrameID,
      frameCount: compactionWindow.frames.length,
      compactionFrameID: visibleFrame.id,
      manual: true,
    });

    let promise = this.runCompaction({
      ...input,
      frameEngine,
      compactionWindow,
      compactionFrameID: visibleFrame.id,
      manual: true,
    })
      .then((frame) => {
        this.emitCompactionEvent('compaction.completed', {
          sessionID: session.id,
          boundaryFrameID: compactionWindow.boundaryFrameID,
          frame,
          compactionFrameID: frame?.id || visibleFrame.id,
          manual: true,
        });
        return frame;
      })
      .catch(async (error) => {
        // P7: manual failures stay `failed` but now carry the structured error.
        let failedFrame = this.updateCompactionFrame({
          frameEngine,
          frameID: visibleFrame.id,
          compactionWindow,
          status: 'failed',
          summary: '',
          message: error?.message || 'Compaction failed.',
          compactorAgent: input.agent || null,
          errors: [ { message: error?.message || 'Compaction failed.', kind: 'compaction' } ],
        });
        await this.flushFrameStores(input.services);
        this.logger.error?.('Kikx manual compaction failed', error);
        this.emitCompactionEvent('compaction.failed', {
          sessionID: session.id,
          boundaryFrameID: compactionWindow.boundaryFrameID,
          compactionFrameID: visibleFrame.id,
          error: {
            message: error?.message || 'Compaction failed',
          },
          manual: true,
        });
        return failedFrame;
      });

    return promise;
  }

  async runCompaction(input = {}) {
    let { session, frameEngine, compactionWindow } = input;
    if (!session?.id || !frameEngine || !compactionWindow?.frames?.length)
      return null;

    let compactorAgent = await this.resolveCompactionAgent(input);
    if (!compactorAgent?.id)
      throw new Error('No agent available for context compaction');

    let ProviderClass = this.resolveProviderClass(compactorAgent);
    if (!ProviderClass)
      throw new Error(`No compaction provider found for agent plugin: ${compactorAgent.pluginID}`);

    let provider = new ProviderClass({
      ...(input.routerContext || {}),
      agent: compactorAgent,
      services: input.services || {},
    });

    if (provider.ask === AgentInterface.prototype.ask)
      throw new Error(`Agent provider ${ProviderClass.name} does not expose a one-shot ask() method for compaction`);

    // R2/R4: size the request to the SELECTED compactor's real window, not the
    // process-wide default. Everything the request must fit is subtracted:
    // instructions + metadata overhead + output reserve.
    let contextBudget = this.resolveCompactionBudget({
      input,
      compactorAgent,
      provider,
      ProviderClass,
      compactionWindow,
    });

    // R4: if the serialized input does not fit, compact in chunks and reduce the
    // summaries. `compactOnce` keeps the single-call path byte-for-byte
    // identical when everything fits.
    let summary = await runChunkedCompaction({
      frames: compactionWindow.frames,
      budgetTokens: contextBudget,
      estimateTokens: (text) => this.contextBuilder.estimateTokens(text),
      compactOnce: async (frames) => {
        let contextText = serializeFramesForCompaction(frames);
        let prompt = buildAgentCompactionPrompt({
          instructions: this.instructions,
          contextText,
          sessionID: session.id,
          frameCount: frames.length,
          startFrameID: frames[0]?.id || compactionWindow.startFrameID,
          boundaryFrameID: frames.at(-1)?.id || compactionWindow.boundaryFrameID,
          contextTokenBudget: contextBudget,
        });
        return await collectCompactionText(provider.ask(prompt, {
          compaction: true,
          oneShot: true,
          agent: compactorAgent,
          session,
          frames,
          sessionFrames: frames,
          config: compactorAgent.config || {},
          secrets: compactorAgent.secrets || {},
          tools: {},
          toolDefinitions: [],
          services: input.services || {},
          maxInputTokens: contextBudget,
        }));
      },
    });

    if (summary.trim() === '')
      throw new Error('Compaction provider returned an empty summary');

    let summaryJSON = buildCompactionSummaryJSON(summary);
    let frame = input.compactionFrameID
      ? this.updateCompactionFrame({
        frameEngine,
        frameID: input.compactionFrameID,
        compactionWindow,
        status: 'complete',
        summary,
        summaryJSON,
        message: 'Compaction complete.',
        compactorAgent,
        warnings: [],
        errors: [],
      })
      : this.createCompactionFrame({
        session,
        compactorAgent,
        compactionWindow,
        summary,
        summaryJSON,
      });

    if (input.compactionFrameID) {
      await this.flushFrameStores(input.services);
      return frame;
    }

    let merged = frameEngine.merge([ frame ], {
      authorType: 'system',
      authorID: 'internal:compaction',
      silent: true,
    });
    await this.flushFrameStores(input.services);
    return merged[0] || frameEngine.get(frame.id) || frame;
  }

  createCompactionFrame(input = {}) {
    return buildCompactionFrame({
      ...input,
      id: this.idGenerator(),
      now: this.clock(),
    });
  }

  updateCompactionFrame({ frameEngine, frameID, compactionWindow, status, summary, summaryJSON, message, compactorAgent, warnings, errors }) {
    let existing = frameEngine.get(frameID);
    if (!existing)
      throw new Error(`Unknown compaction frame: ${frameID}`);

    let nextFrame = buildCompactionFrameUpdate({
      existing,
      now: this.clock(),
      compactionWindow,
      status,
      summary,
      summaryJSON,
      message,
      compactorAgent,
      warnings,
      errors,
    });
    let merged = frameEngine.merge([ nextFrame ], {
      authorType: 'system',
      authorID: 'internal:compaction',
    });
    return merged[0] || frameEngine.get(frameID) || nextFrame;
  }

  // P7 failure -> trim fallback. Write (or update) a VISIBLE boundary frame with
  // `status:'trimmed'`, no summary, and the failure recorded as a warning plus
  // errors. It carries the full `compactionWindow` metadata so the projection
  // start is exact (`boundaryFrameID`/`boundaryOrder`). Old frames stay in
  // storage untouched. Returns the stored frame so callers always get a frame.
  writeTrimmedBoundary(input = {}, error = null) {
    let { frameEngine, compactionWindow } = input;
    let sessionID = input.session?.id || input.sessionID || input.triggerFrame?.sessionID;
    if (!frameEngine || !sessionID || !compactionWindow)
      return null;

    let session = input.session?.id ? input.session : { id: sessionID };
    let message = error?.message || 'Compaction failed';
    let fields = {
      session,
      compactorAgent: input.agent || null,
      compactionWindow,
      status: 'trimmed',
      summary: '',
      message: 'Context was trimmed to proceed.',
      warnings: [ 'Compaction failed; context was trimmed to proceed.' ],
      errors: [ { message, kind: 'compaction' } ],
    };

    if (input.compactionFrameID && frameEngine.get(input.compactionFrameID))
      return this.updateCompactionFrame({ ...fields, frameEngine, frameID: input.compactionFrameID });

    let frame = this.createCompactionFrame(fields);
    let merged = frameEngine.merge([ frame ], {
      authorType: 'system',
      authorID: 'internal:compaction',
    });
    return merged[0] || frameEngine.get(frame.id) || frame;
  }

  async resolveCompactionAgent(input = {}) {
    let agentManager = this.agentManager || resolveService(input.services, 'agentManager');
    let pluginRegistry = this.pluginRegistry || resolveService(input.services, 'pluginRegistry');
    let catalog = input.catalog || this.catalog || agentManager?.listModels?.() || [];

    return await resolveCompactionAgentForSession({
      compactionAgentID: this.compactionAgentID,
      agentManager,
      pluginRegistry,
      catalog,
      input,
    });
  }

  resolveProviderClass(agent) {
    let pluginRegistry = this.pluginRegistry;
    if (!pluginRegistry && this.frameRuntime?.services)
      pluginRegistry = resolveService(this.frameRuntime.services, 'pluginRegistry');

    return pluginRegistry?.getAgentProvider?.(agent.pluginID) || null;
  }

  countInstructionTokens() {
    return this.contextBuilder.estimateTokens(this.instructions);
  }

  // R2/R4: the input budget for the compactor request. The window comes from the
  // selected provider instance's resolver when present, else shared resolution.
  // The legacy `compactionAgentContextTokens` is only a fallback when the window
  // cannot be determined.
  resolveCompactionBudget({ input = {}, compactorAgent, provider, ProviderClass, compactionWindow } = {}) {
    let agentManager = this.agentManager || resolveService(input.services, 'agentManager');
    let catalog = input.catalog || this.catalog || agentManager?.listModels?.() || [];
    let window = resolveCompactorWindow({ compactorAgent, provider, ProviderClass, catalog });
    let metadataTokens = countCompactionMetadataTokens({
      estimateTokens: (text) => this.contextBuilder.estimateTokens(text),
      compactionWindow,
      frameCount: compactionWindow?.frames?.length || 0,
    });

    return computeCompactionBudget({
      window,
      fallbackWindow: this.compactionAgentContextTokens,
      instructionTokens: this.countInstructionTokens(),
      metadataTokens,
      outputReserveTokens: this.compactionOutputReserveTokens,
    });
  }

  emitCompactionEvent(type, payload = {}) {
    if (typeof this.frameRuntime?.emitRuntimeEvent === 'function') {
      this.frameRuntime.emitRuntimeEvent(type, payload);
      return;
    }

    if (typeof this.frameRuntime?.emit === 'function')
      this.frameRuntime.emit(type, { type, ...payload });
  }

  async flushFrameStores(services = {}) {
    await services?.frameRuntime?.frameStore?.flush?.();
    await this.frameRuntime?.frameStore?.flush?.();
  }
}

async function collectCompactionText(result) {
  let text = '';

  if (typeof result === 'string')
    return result;

  if (result && typeof result.then === 'function')
    return await collectCompactionText(await result);

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    for await (let output of result)
      text += extractOutputText(output);

    return text;
  }

  if (result && typeof result[Symbol.iterator] === 'function') {
    for (let output of result)
      text += extractOutputText(output);

    return text;
  }

  return extractOutputText(result);
}

function extractOutputText(output) {
  if (typeof output === 'string')
    return output;

  if (typeof output?.content === 'string')
    return output.content;

  if (typeof output?.content?.text === 'string')
    return output.content.text;

  if (typeof output?.text === 'string')
    return output.text;

  return '';
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

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizePositiveInteger(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function normalizeRatio(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return fallback;

  return Math.min(number, 1);
}
