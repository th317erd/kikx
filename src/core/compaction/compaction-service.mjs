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
import { resolveSessionWindows } from './effective-windows.mjs';
import {
  FrameContextBuilder,
  serializeFramesForCompaction,
} from './frame-context-builder.mjs';
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

    if (result.shouldWaitForCompaction && pending) {
      await pending.catch((error) => {
        this.logger.error?.('Kikx compaction failed while waiting at hard context limit', error);
      });

      let nextFrames = projectFrameMessages(typeof frameEngine?.toArray === 'function' ? frameEngine.toArray() : frames);
      return this.contextBuilder.build(nextFrames, {
        activeFrameID: input.triggerFrame?.id || input.activeFrameID,
        ...triggerOptions,
        compactionContextBudgetTokens: Math.max(1, this.compactionAgentContextTokens - this.countInstructionTokens()),
        compactionTriggerRatio: input.compactionTriggerRatio || this.compactionTriggerRatio,
        hardLimitRatio: input.hardLimitRatio || this.hardLimitRatio,
      });
    }

    return {
      ...result,
      compactionPending: true,
    };
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
      .catch((error) => {
        this.logger.error?.('Kikx async compaction failed', error);
        this.emitCompactionEvent('compaction.failed', {
          sessionID,
          boundaryFrameID,
          error: {
            message: error?.message || 'Compaction failed',
          },
        });
        return null;
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
        let failedFrame = this.updateCompactionFrame({
          frameEngine,
          frameID: visibleFrame.id,
          compactionWindow,
          status: 'failed',
          summary: '',
          message: error?.message || 'Compaction failed.',
          compactorAgent: input.agent || null,
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

  updateCompactionFrame({ frameEngine, frameID, compactionWindow, status, summary, summaryJSON, message, compactorAgent }) {
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
    });
    let merged = frameEngine.merge([ nextFrame ], {
      authorType: 'system',
      authorID: 'internal:compaction',
    });
    return merged[0] || frameEngine.get(frameID) || nextFrame;
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
