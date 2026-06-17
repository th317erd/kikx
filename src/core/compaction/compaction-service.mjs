'use strict';

import { randomUUID } from 'node:crypto';

import { AgentInterface } from '../plugins/agent-interface.mjs';
import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
  buildAgentCompactionPrompt,
  buildDefaultCompactionInstructions,
} from './agent-compaction-template.mjs';
import {
  FrameContextBuilder,
  serializeFramesForCompaction,
} from './frame-context-builder.mjs';

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
    this.compactionTriggerRatio = normalizeRatio(options.compactionTriggerRatio, DEFAULT_COMPACTION_TRIGGER_RATIO);
    this.hardLimitRatio = normalizeRatio(options.hardLimitRatio, DEFAULT_HARD_LIMIT_RATIO);
    this.instructions = options.instructions || buildDefaultCompactionInstructions();
    this.contextBuilder = options.contextBuilder || new FrameContextBuilder({
      contextWindowTokens: this.contextWindowTokens,
      promptReserveTokens: this.promptReserveTokens,
      compactionTriggerRatio: this.compactionTriggerRatio,
      hardLimitRatio: this.hardLimitRatio,
      estimateTokens: options.estimateTokens,
    });
    this.pendingCompactions = new Map();
  }

  async prepareAgentContext(input = {}) {
    let frameEngine = input.frameEngine;
    let frames = typeof frameEngine?.toArray === 'function' ? frameEngine.toArray() : input.frames || [];
    let result = this.contextBuilder.build(frames, {
      activeFrameID: input.triggerFrame?.id || input.activeFrameID,
      contextWindowTokens: input.contextWindowTokens || this.contextWindowTokens,
      promptReserveTokens: input.promptReserveTokens || this.promptReserveTokens,
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

      let nextFrames = typeof frameEngine?.toArray === 'function' ? frameEngine.toArray() : frames;
      return this.contextBuilder.build(nextFrames, {
        activeFrameID: input.triggerFrame?.id || input.activeFrameID,
        contextWindowTokens: input.contextWindowTokens || this.contextWindowTokens,
        promptReserveTokens: input.promptReserveTokens || this.promptReserveTokens,
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

    let frames = typeof frameEngine.toArray === 'function' ? frameEngine.toArray() : input.frames || [];
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

    let contextBudget = Math.max(1, this.compactionAgentContextTokens - this.countInstructionTokens());
    let contextText = compactionWindow.contextText || serializeFramesForCompaction(compactionWindow.frames);
    let prompt = buildAgentCompactionPrompt({
      instructions: this.instructions,
      contextText,
      sessionID: session.id,
      frameCount: compactionWindow.frames.length,
      startFrameID: compactionWindow.startFrameID,
      boundaryFrameID: compactionWindow.boundaryFrameID,
      contextTokenBudget: contextBudget,
    });
    let summary = await collectCompactionText(provider.ask(prompt, {
      compaction: true,
      oneShot: true,
      agent: compactorAgent,
      session,
      frames: compactionWindow.frames,
      sessionFrames: compactionWindow.frames,
      tools: {},
      toolDefinitions: [],
      services: input.services || {},
      maxInputTokens: contextBudget,
    }));

    if (summary.trim() === '')
      throw new Error('Compaction provider returned an empty summary');

    let frame = input.compactionFrameID
      ? this.updateCompactionFrame({
        frameEngine,
        frameID: input.compactionFrameID,
        compactionWindow,
        status: 'complete',
        summary,
        message: 'Compaction complete.',
        compactorAgent,
      })
      : this.createCompactionFrame({
        session,
        compactorAgent,
        compactionWindow,
        summary,
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

  createCompactionFrame({
    session,
    compactorAgent,
    compactionWindow,
    summary,
    status = 'complete',
    hidden = true,
    manual = false,
    requestedByFrameID = null,
    message = '',
  }) {
    let now = this.clock();
    let frameIDs = compactionWindow.frames.map((frame) => frame.id);
    let boundaryFrame = compactionWindow.frames.at(-1);
    let frameTime = manual ? now : boundaryFrame?.createdAt || boundaryFrame?.timestamp || now;
    return {
      id: this.idGenerator(),
      type: COMPACTION_FRAME_TYPE,
      sessionID: session.id,
      interactionID: `compaction-${compactionWindow.boundaryFrameID || now}`,
      parentID: compactionWindow.boundaryFrameID || null,
      authorType: 'system',
      authorID: 'internal:compaction',
      authorDisplayName: 'Kikx compaction',
      timestamp: manual ? now : boundaryFrame?.timestamp || now,
      createdAt: frameTime,
      updatedAt: now,
      hidden,
      deleted: false,
      compaction: {
        kind: COMPACTION_FRAME_KIND,
        status,
        manual,
        requestedByFrameID,
        compactorAgentID: compactorAgent?.id || null,
        compactorAgentName: compactorAgent?.name || compactorAgent?.id || null,
        frameCount: frameIDs.length,
        frameIDs,
        startFrameID: compactionWindow.startFrameID,
        boundaryFrameID: compactionWindow.boundaryFrameID,
        boundaryOrder: compactionWindow.boundaryOrder,
        contextTokens: compactionWindow.tokens,
        createdAt: now,
      },
      content: {
        kind: COMPACTION_FRAME_KIND,
        status,
        text: message || summary,
        summary,
        manual,
        requestedByFrameID,
        compactorAgentID: compactorAgent?.id || null,
        frameCount: frameIDs.length,
        startFrameID: compactionWindow.startFrameID,
        boundaryFrameID: compactionWindow.boundaryFrameID,
        boundaryOrder: compactionWindow.boundaryOrder,
      },
    };
  }

  updateCompactionFrame({ frameEngine, frameID, compactionWindow, status, summary, message, compactorAgent }) {
    let existing = frameEngine.get(frameID);
    if (!existing)
      throw new Error(`Unknown compaction frame: ${frameID}`);

    let now = this.clock();
    let frameIDs = compactionWindow.frames.map((frame) => frame.id);
    let nextFrame = {
      ...existing,
      updatedAt: now,
      compaction: {
        ...(existing.compaction || {}),
        status,
        compactorAgentID: compactorAgent?.id || existing.compaction?.compactorAgentID || null,
        compactorAgentName: compactorAgent?.name || compactorAgent?.id || existing.compaction?.compactorAgentName || null,
        frameCount: frameIDs.length,
        frameIDs,
        startFrameID: compactionWindow.startFrameID,
        boundaryFrameID: compactionWindow.boundaryFrameID,
        boundaryOrder: compactionWindow.boundaryOrder,
        contextTokens: compactionWindow.tokens,
        updatedAt: now,
      },
      content: {
        ...(existing.content || {}),
        kind: COMPACTION_FRAME_KIND,
        status,
        text: message || summary || existing.content?.text || '',
        summary: summary ?? existing.content?.summary ?? '',
        compactorAgentID: compactorAgent?.id || existing.content?.compactorAgentID || null,
        frameCount: frameIDs.length,
        startFrameID: compactionWindow.startFrameID,
        boundaryFrameID: compactionWindow.boundaryFrameID,
        boundaryOrder: compactionWindow.boundaryOrder,
      },
    };
    let merged = frameEngine.merge([ nextFrame ], {
      authorType: 'system',
      authorID: 'internal:compaction',
    });
    return merged[0] || frameEngine.get(frameID) || nextFrame;
  }

  async resolveCompactionAgent(input = {}) {
    let agentID = this.compactionAgentID
      || normalizeOptionalString(input.session?.compactionAgentID)
      || findAlternateAgentID(input.session?.participantAgentIDs, input.agent?.id)
      || normalizeOptionalString(input.agent?.id);

    if (!agentID) {
      let firstParticipant = normalizeStringArray(input.session?.participantAgentIDs)[0];
      agentID = firstParticipant || null;
    }

    if (!agentID)
      return null;

    let agentManager = this.agentManager || resolveService(input.services, 'agentManager');
    if (!agentManager?.getAgent)
      return input.agent?.id === agentID ? input.agent : null;

    return await agentManager.getAgent(agentID, { includeSecrets: true });
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

function findAlternateAgentID(agentIDs, currentAgentID) {
  let ids = normalizeStringArray(agentIDs);
  return ids.find((agentID) => agentID !== currentAgentID) || null;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values))
    return [];

  let result = [];
  for (let value of values) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!result.includes(item))
      result.push(item);
  }

  return result;
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
