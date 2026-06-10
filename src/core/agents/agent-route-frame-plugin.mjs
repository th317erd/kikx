'use strict';

import { BaseFramePlugin } from '../routing/index.mjs';
import {
  mergeMentionMaps,
  resolveMentionActors,
} from '../mentions/index.mjs';
import { normalizeProviderUsage } from '../tokens/index.mjs';

const DEFAULT_CONTINUATION_DELAY_MS = 1000;
const MIN_CONTINUATION_DELAY_MS = 250;
const MAX_CONTINUATION_DELAY_MS = 10 * 60 * 1000;

export class AgentRouteFramePlugin extends BaseFramePlugin {
  static pluginID = 'internal:agent-router';

  async process(next, done) {
    let frame = this.context.newFrame;
    if (!shouldRouteToAgents(this.context, frame)) {
      await next(this.context);
      return;
    }

    let participantAgentIDs = normalizeStringArray(this.context.session?.participantAgentIDs);
    if (participantAgentIDs.length === 0) {
      await next(this.context);
      return;
    }

    let coordinatorAgentID = resolveCoordinatorAgentID(this.context.session, participantAgentIDs);
    if (!coordinatorAgentID) {
      await next(this.context);
      return;
    }

    let services = this.context.services || {};
    let agentManager = resolveService(services, 'agentManager');
    let pluginRegistry = resolveService(services, 'pluginRegistry');

    if (!agentManager)
      throw new Error('AgentRouteFramePlugin requires agentManager');

    if (!pluginRegistry)
      throw new Error('AgentRouteFramePlugin requires pluginRegistry');

    let routeTargets = resolveRouteTargets({ frame, participantAgentIDs, coordinatorAgentID });
    if (routeTargets.length === 0) {
      await next(this.context);
      return;
    }

    for (let agentID of routeTargets) {
      let result = await this.routeAgent({
        agentID,
        coordinatorAgentID,
        agentManager,
        pluginRegistry,
        services,
        frame,
      });

      if (result?.status === 'forwarded')
        break;
    }

    done();
  }

  async routeAgent({ agentID, coordinatorAgentID, agentManager, pluginRegistry, services, frame }) {
    let agent;
    let responseFrameID = null;
    let doneStatus = '';
    let continuation = null;
    try {
      agent = await agentManager.getAgent(agentID, { includeSecrets: true });
      if (!agent?.id)
        throw new Error(`Unknown agent: ${agentID}`);

      if (agent.enabled === false)
        throw new Error(`Agent is disabled: ${agentID}`);

      let ProviderClass = pluginRegistry.getAgentProvider(agent.pluginID);
      if (!ProviderClass)
        throw new Error(`Unknown agent provider: ${agent.pluginID}`);

      responseFrameID = this.context.engine.idGenerator();
      let responseFrame = await this.createResponseFrame({ agent, frame, responseFrameID, services });
      let participantAgents = await this.loadParticipantAgents({
        participantAgentIDs: this.context.session?.participantAgentIDs,
        agentManager,
        currentAgent: agent,
      });
      let sessionFrames = typeof this.context.engine.toArray === 'function'
        ? this.context.engine.toArray()
        : [];
      let tokenUsage = resolveService(services, 'tokenUsage');
      let tokenUsageSnapshot = typeof tokenUsage?.snapshot === 'function' ? tokenUsage.snapshot() : {};
      let providerServices = this.providerServices({ services, agent, frame });
      let provider = new ProviderClass({
        ...this.context,
        agent,
        services: providerServices,
      });
      let runParams = {
        frame,
        userFrame: frame,
        session: this.context.session,
        participantAgents,
        agent,
        config: agent.config || {},
        secrets: agent.secrets || {},
        frames: sessionFrames,
        sessionFrames,
        tokenUsage: tokenUsageSnapshot,
        totalTokensUsed: typeof tokenUsage?.totalTokensUsed === 'function'
          ? tokenUsage.totalTokensUsed()
          : totalTokensUsed(tokenUsageSnapshot),
        services: providerServices,
        responseFrameID,
        responseFrame,
        coordinatorAgentID,
        isCoordinator: agent.id === coordinatorAgentID,
      };

      for await (let output of provider.run(runParams)) {
        if (output?.type === 'Done') {
          let status = normalizeDoneStatus(output.content?.status);
          doneStatus = status || doneStatus;
          continuation = normalizeContinuation(output.content?.continuation) || continuation;
          if (shouldCleanupResponseFrame(status))
            this.cleanupResponseFrame({ responseFrameID, responseFrame, agent, status });

          await this.recordProviderUsage({
            output,
            ProviderClass,
            agent,
            frame,
            responseFrameID,
            services,
          });

          continue;
        }

        this.mergeProviderFrame(output, { agent, frame, responseFrameID });
      }

      if (continuation && responseFrameID)
        this.scheduleAgentContinuation({ agent, frame, responseFrameID, continuation, services });

      return { status: doneStatus };
    } catch (error) {
      this.appendAgentError({
        agent: agent || { id: agentID, name: agentID },
        frame,
        error,
        responseFrameID,
      });

      return { status: 'error' };
    }
  }

  async loadParticipantAgents({ participantAgentIDs, agentManager, currentAgent = null }) {
    let agents = [];
    for (let agentID of normalizeStringArray(participantAgentIDs)) {
      let agent = null;
      if (currentAgent?.id === agentID) {
        agent = currentAgent;
      } else {
        try {
          agent = await agentManager.getAgent(agentID, { includeSecrets: false });
        } catch (_error) {
          agent = null;
        }
      }

      agents.push(sanitizeParticipantAgent(agent || { id: agentID }));
    }

    return agents;
  }

  providerServices({ services, agent, frame }) {
    let tokenUsage = resolveService(services, 'tokenUsage');
    return {
      ...services,
      ...(tokenUsage ? {
        tokenUsage,
        addTokens: async (serviceKey, usage, options = {}) => await tokenUsage.addTokens(serviceKey, usage, options),
      } : {}),
      forwardFrame: async (forward) => await this.forwardFrame({
        ...forward,
        agent,
        frame,
        services,
      }),
    };
  }

  async recordProviderUsage({ output, ProviderClass, agent, frame, responseFrameID, services }) {
    let usage = normalizeProviderUsage(output.content?.usage);
    if (!usage)
      return null;

    let serviceKey = resolveTokenServiceKey({ usage, ProviderClass, agent });
    let tokenUsage = resolveService(services, 'tokenUsage');
    let aggregateEntry = null;
    if (usage.tracked !== true && tokenUsage && typeof tokenUsage.addTokens === 'function') {
      aggregateEntry = await tokenUsage.addTokens(serviceKey, usage, {
        updatedAt: this.clock(),
      });
    }

    this.mergeFrameTokenUsage({ frame, responseFrameID, serviceKey, usage });
    await services?.frameRuntime?.frameStore?.flush?.();

    return {
      serviceKey,
      usage,
      aggregateEntry,
    };
  }

  mergeFrameTokenUsage({ frame, responseFrameID, serviceKey, usage }) {
    let sourceReadTokens = usage.readTokens || usage.inputTokens;
    if (sourceReadTokens > 0) {
      this.mergeSingleFrameTokenUsage({
        frameID: frame.id,
        serviceKey,
        tokenUsage: {
          readTokens: sourceReadTokens,
          inputTokens: usage.inputTokens,
          tokensUsed: sourceReadTokens,
        },
      });
    }

    if (!responseFrameID)
      return;

    this.mergeSingleFrameTokenUsage({
      frameID: responseFrameID,
      serviceKey,
      tokenUsage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        readTokens: usage.readTokens,
        writeTokens: usage.writeTokens || usage.outputTokens,
        tokensUsed: usage.tokensUsed,
      },
    });
  }

  mergeSingleFrameTokenUsage({ frameID, serviceKey, tokenUsage }) {
    let existing = this.context.engine.get(frameID);
    if (!existing)
      return;

    let now = this.clock();
    let next = mergeFrameUsage(existing.tokenUsage, serviceKey, tokenUsage, now);
    this.context.engine.merge([{
      ...existing,
      tokenUsage: next,
    }], {
      authorType: 'system',
      authorID: 'token-usage',
      silent: true,
    });
  }

  async createResponseFrame({ agent, frame, responseFrameID, services }) {
    let now = this.clock();
    let agentRoute = createResponseAgentRoute({ sourceFrame: frame, agentID: agent.id });
    let responseFrame = {
      id: responseFrameID,
      type: 'AgentMessage',
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: frame.id,
      authorType: 'agent',
      authorID: agent.id,
      authorDisplayName: agent.name || agent.id,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      hidden: true,
      deleted: false,
      agentRoute,
      content: {
        text: '',
        thinking: {
          text: '',
          status: 'pending',
        },
        status: 'streaming',
      },
    };

    let merged = this.context.engine.merge([ responseFrame ], {
      authorType: 'agent',
      authorID: agent.id,
    });

    await services?.frameRuntime?.frameStore?.flush?.();

    return merged[0] || this.context.engine.get(responseFrameID) || responseFrame;
  }

  mergeProviderFrame(output, { agent, frame, responseFrameID }) {
    if (!output || output.type === 'Done')
      return;

    let now = this.clock();
    let content = normalizeProviderContent(output, this.context.engine.get(responseFrameID));
    let mergedFrame = {
      ...output,
      id: output.id || (output.phantom ? this.context.engine.idGenerator() : responseFrameID),
      responseFrameID: output.responseFrameID || responseFrameID,
      sessionID: output.sessionID || frame.sessionID,
      interactionID: output.interactionID || frame.interactionID,
      parentID: output.parentID ?? frame.id,
      authorType: output.authorType || 'agent',
      authorID: output.authorID || agent.id,
      authorDisplayName: output.authorDisplayName || agent.name || agent.id,
      timestamp: output.timestamp || now,
      createdAt: output.createdAt || now,
      updatedAt: output.updatedAt || now,
      hidden: output.hidden ?? (output.phantom ? true : false),
      deleted: output.deleted ?? false,
      agentRoute: output.agentRoute || this.context.engine.get(responseFrameID)?.agentRoute,
      content,
    };

    this.context.engine.merge([ mergedFrame ], {
      authorType: 'agent',
      authorID: agent.id,
    });
  }

  appendAgentError({ agent, frame, error, responseFrameID = null }) {
    let now = this.clock();
    let type = responseFrameID ? 'AgentMessage' : 'AgentError';
    let existingResponseFrame = responseFrameID ? this.context.engine.get(responseFrameID) : null;
    this.context.engine.merge([{
      id: responseFrameID || this.context.engine.idGenerator(),
      type,
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: frame.id,
      authorType: 'agent',
      authorID: agent.id,
      authorDisplayName: agent.name || agent.id,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      hidden: false,
      deleted: false,
      agentRoute: existingResponseFrame?.agentRoute,
      content: {
        agentID: agent.id,
        agentName: agent.name || agent.id,
        text: error?.message || 'Agent provider failed',
        error: {
          message: error?.message || 'Agent provider failed',
        },
        status: 'error',
      },
    }], {
      authorType: 'agent',
      authorID: agent.id,
    });
  }

  cleanupResponseFrame({ responseFrameID, responseFrame, agent, status }) {
    if (!responseFrameID)
      return;

    this.context.engine.merge([{
      ...responseFrame,
      id: responseFrameID,
      type: 'AgentMessage',
      authorDisplayName: responseFrame?.authorDisplayName || agent.name || agent.id,
      hidden: true,
      deleted: true,
      content: {
        ...(responseFrame?.content || {}),
        status,
      },
    }], {
      authorType: 'agent',
      authorID: agent.id,
      silent: true,
    });
  }

  async forwardFrame({ frame, targets = [], message = '', services = {}, agent = null }) {
    let participantAgentIDs = normalizeStringArray(this.context.session?.participantAgentIDs);
    let coordinatorAgentID = resolveCoordinatorAgentID(this.context.session, participantAgentIDs);
    if (!agent?.id || agent.id !== coordinatorAgentID)
      throw new Error('Only the session coordinator can forward frames');

    let targetMentions = await resolveMentionActors(targets, {
      ...this.context.services,
      ...services,
    });
    let mentions = mergeMentionMaps(frame.mentions, targetMentions);
    let updated = {
      ...frame,
      mentions,
      coordinated: true,
    };
    if (message)
      updated.coordination = { message };

    let merged = this.context.engine.merge([ updated ], {
      authorType: 'agent',
      authorID: agent?.id || null,
      silent: true,
    });
    let updatedFrame = merged[0] || this.context.engine.get(frame.id) || updated;
    await services?.frameRuntime?.frameStore?.flush?.();

    let frameRouter = resolveService(services, 'frameRouter') || services?.frameRuntime?.frameRouter;
    let commit = this.context.engine.getLatestCommit();
    if (!frameRouter || !commit)
      return updatedFrame;

    await Promise.resolve();
    frameRouter.enqueue(this.context.engine, {
      ...commit,
      silent: false,
      changes: commit.changes.map((change) => ({ ...change, operation: 'update' })),
    }, this.context.session, {
      services: this.context.services,
    });

    return updatedFrame;
  }

  clock() {
    return this.context.services?.clock?.() || Date.now();
  }

  scheduleAgentContinuation({ agent, frame, responseFrameID, continuation, services = {} }) {
    let scheduler = resolveContinuationScheduler(services);
    let delayMs = normalizeContinuationDelay(continuation.delayMs);
    let schedule = {
      agentID: agent.id,
      responseFrameID,
      sourceFrameID: frame.id,
      delayMs,
      reason: continuation.reason || '',
    };
    scheduler({
      delayMs,
      continuation: schedule,
      callback: async () => {
        await this.createAgentContinuationFrame({
          agent,
          frame,
          responseFrameID,
          continuation: schedule,
          services,
        });
      },
    });
  }

  async createAgentContinuationFrame({ agent, frame, responseFrameID, continuation, services = {} }) {
    let responseFrame = this.context.engine.get(responseFrameID);
    if (!responseFrame || responseFrame.deleted === true)
      return null;

    let now = this.clock();
    let continuationFrame = {
      id: this.context.engine.idGenerator(),
      type: 'AgentContinuation',
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: responseFrameID,
      authorType: 'system',
      authorID: 'internal:agent-continuation',
      targetAgentID: agent.id,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      hidden: true,
      deleted: false,
      continuation: {
        ...continuation,
        firedAt: now,
      },
      content: {
        text: buildContinuationPromptText({ agent, responseFrame, continuation }),
        status: 'ready',
        agentID: agent.id,
        agentName: agent.name || agent.id,
        sourceFrameID: frame.id,
        responseFrameID,
        reason: continuation.reason || '',
      },
    };

    let merged = this.context.engine.merge([ continuationFrame ], {
      authorType: 'system',
      authorID: 'internal:agent-continuation',
    });
    await services?.frameRuntime?.frameStore?.flush?.();
    return merged[0] || this.context.engine.get(continuationFrame.id) || continuationFrame;
  }
}

export function registerAgentRouting(frameRouter) {
  if (!frameRouter?.registerSelector)
    throw new TypeError('registerAgentRouting() requires a FrameRouter');

  frameRouter.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
  frameRouter.registerSelector('Type:AgentMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
  frameRouter.registerSelector('Type:AgentContinuation', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
}

function shouldRouteToAgents(context, frame) {
  if (frame?.type === 'AgentContinuation')
    return shouldRouteAgentContinuation(context, frame);

  if (!frame || frame.phantom || frame.hidden === true || frame.deleted === true)
    return false;

  if (frame.type === 'UserMessage')
    return shouldRouteUserMessage(context, frame);

  if (frame.type === 'AgentMessage')
    return shouldRouteAgentMessage(context, frame);

  return false;
}

function shouldRouteUserMessage(context, frame) {
  if (context.change?.operation && context.change.operation !== 'create' && frame?.coordinated !== true)
    return false;

  let text = frame.content?.text;
  if (typeof text === 'string' && text.trim().startsWith('/'))
    return false;

  return true;
}

function shouldRouteAgentMessage(context, frame) {
  if (frame.authorType !== 'agent' || typeof frame.authorID !== 'string' || frame.authorID.trim() === '')
    return false;

  if (frame.content?.status === 'streaming')
    return false;

  let operation = context.change?.operation || 'create';
  if (operation === 'create')
    return true;

  if (operation !== 'update')
    return false;

  if (frame.coordinated === true)
    return false;

  let previous = context.previousFrame || {};
  let becameVisible = previous.hidden !== false && frame.hidden === false;
  let finalized = previous.content?.status === 'streaming' && frame.content?.status !== 'streaming';
  return becameVisible || finalized;
}

function shouldRouteAgentContinuation(context, frame) {
  if (!frame || frame.deleted === true)
    return false;

  if (typeof frame.targetAgentID !== 'string' || frame.targetAgentID.trim() === '')
    return false;

  let operation = context.change?.operation || 'create';
  return operation === 'create';
}

function resolveRouteTargets({ frame, participantAgentIDs, coordinatorAgentID }) {
  if (frame?.type === 'AgentContinuation')
    return participantAgentIDs.includes(frame.targetAgentID) ? [ frame.targetAgentID ] : [];

  if (frame?.type === 'AgentMessage') {
    return participantAgentIDs.filter((agentID) => agentID !== frame.authorID);
  }

  if (frame?.coordinated === true) {
    let mentionedAgentIDs = Object.entries(frame.mentions || {})
      .filter(([actorID, mention]) => mention?.type === 'agent' || participantAgentIDs.includes(actorID))
      .map(([actorID]) => actorID)
      .filter((actorID) => actorID !== coordinatorAgentID && participantAgentIDs.includes(actorID));

    return uniqueStrings(mentionedAgentIDs);
  }

  return uniqueStrings([ coordinatorAgentID, ...participantAgentIDs ]);
}

function createResponseAgentRoute({ sourceFrame, agentID }) {
  let inherited = normalizeAgentRoute(sourceFrame?.agentRoute);
  let inheritedPath = inherited.path.length > 0
    ? inherited.path
    : normalizeStringArray(sourceFrame?.authorType === 'agent' ? [ sourceFrame.authorID ] : []);

  return {
    rootFrameID: inherited.rootFrameID || sourceFrame?.id || null,
    sourceFrameID: sourceFrame?.id || null,
    path: uniqueStrings([ ...inheritedPath, agentID ]),
  };
}

function normalizeAgentRoute(agentRoute) {
  if (!agentRoute || typeof agentRoute !== 'object') {
    return {
      rootFrameID: null,
      sourceFrameID: null,
      path: [],
    };
  }

  return {
    rootFrameID: typeof agentRoute.rootFrameID === 'string' && agentRoute.rootFrameID.trim()
      ? agentRoute.rootFrameID.trim()
      : null,
    sourceFrameID: typeof agentRoute.sourceFrameID === 'string' && agentRoute.sourceFrameID.trim()
      ? agentRoute.sourceFrameID.trim()
      : null,
    path: normalizeStringArray(agentRoute.path),
  };
}

function resolveTokenServiceKey({ usage, ProviderClass, agent }) {
  if (usage.serviceKey)
    return usage.serviceKey;

  let explicit = normalizeOptionalString(ProviderClass?.tokenServiceKey || ProviderClass?.serviceKey);
  if (explicit)
    return explicit;

  let serviceType = normalizeOptionalString(ProviderClass?.serviceType);
  let agentType = normalizeOptionalString(ProviderClass?.agentType);
  let pluginID = normalizeOptionalString(agent?.pluginID || ProviderClass?.pluginID || agent?.id);
  let parts = [];
  for (let part of [ serviceType, agentType, pluginID ]) {
    if (part)
      parts.push(part);
  }

  return parts.length > 0 ? parts.join('/') : 'unknown/agent';
}

function mergeFrameUsage(existingUsage, serviceKey, delta, timestamp) {
  let existing = (existingUsage && typeof existingUsage === 'object' && !Array.isArray(existingUsage))
    ? existingUsage
    : {};
  let existingEntry = (existing[serviceKey] && typeof existing[serviceKey] === 'object' && !Array.isArray(existing[serviceKey]))
    ? existing[serviceKey]
    : {};
  let nextEntry = {
    ...existingEntry,
    createdAt: existingEntry.createdAt || timestamp,
    updatedAt: timestamp,
  };

  for (let [key, value] of Object.entries(delta || {})) {
    let amount = normalizeNonNegativeInteger(value);
    if (amount <= 0)
      continue;

    nextEntry[key] = normalizeNonNegativeInteger(existingEntry[key]) + amount;
  }

  return {
    ...existing,
    [serviceKey]: nextEntry,
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNonNegativeInteger(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return 0;

  return Math.trunc(number);
}

function totalTokensUsed(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot || {}))
    total += normalizeNonNegativeInteger(entry?.tokensUsed);

  return total;
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

function uniqueStrings(values) {
  let unique = [];
  for (let value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!unique.includes(item))
      unique.push(item);
  }

  return unique;
}

function resolveCoordinatorAgentID(session, participantAgentIDs) {
  if (typeof session?.coordinatorAgentID === 'string') {
    let coordinatorAgentID = session.coordinatorAgentID.trim();
    if (participantAgentIDs.includes(coordinatorAgentID))
      return coordinatorAgentID;
  }

  return participantAgentIDs[0] || null;
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

function sanitizeParticipantAgent(agent) {
  let id = typeof agent?.id === 'string' ? agent.id.trim() : '';
  let name = typeof agent?.name === 'string' ? agent.name.trim() : '';
  let pluginID = typeof agent?.pluginID === 'string'
    ? agent.pluginID.trim()
    : (typeof agent?.pluginId === 'string' ? agent.pluginId.trim() : '');

  return {
    id,
    name: name || id,
    pluginID,
  };
}

function normalizeProviderContent(output, existingResponseFrame) {
  let content = {
    ...(output.content || {}),
  };

  if (output.phantom || output.type !== 'AgentMessage')
    return content;

  let existingThinking = existingResponseFrame?.content?.thinking || {};
  content.status = content.status || 'complete';
  content.thinking = {
    ...existingThinking,
    ...(content.thinking || {}),
    status: content.thinking?.status || 'complete',
  };

  return content;
}

function normalizeContinuation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  return {
    delayMs: normalizeContinuationDelay(value.delayMs),
    reason: normalizeOptionalString(value.reason || value.message),
  };
}

function normalizeContinuationDelay(value) {
  if (value == null || value === '')
    return DEFAULT_CONTINUATION_DELAY_MS;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return DEFAULT_CONTINUATION_DELAY_MS;

  return Math.min(MAX_CONTINUATION_DELAY_MS, Math.max(MIN_CONTINUATION_DELAY_MS, Math.trunc(number)));
}

function resolveContinuationScheduler(services = {}) {
  let scheduler = resolveService(services, 'agentContinuationScheduler');
  if (typeof scheduler === 'function')
    return scheduler;

  return ({ delayMs, callback }) => {
    let timer = setTimeout(() => {
      Promise.resolve(callback()).catch((error) => {
        services?.logger?.error?.('Agent continuation callback failed', error);
      });
    }, delayMs);
    timer.unref?.();
    return timer;
  };
}

function buildContinuationPromptText({ agent, responseFrame, continuation }) {
  let priorText = normalizeOptionalString(responseFrame?.content?.text);
  let reason = normalizeOptionalString(continuation.reason);
  return [
    `Your respond-and-continue timer has fired for ${agent.name || agent.id}.`,
    reason ? `Continuation reason: ${reason}` : 'Continue the work you intentionally scheduled.',
    priorText ? `Your previous visible response was:\n${priorText}` : '',
    'Decide whether to use tools, respond visibly, schedule another continuation, or stay silent.',
  ].filter(Boolean).join('\n\n');
}

function normalizeDoneStatus(status) {
  if (typeof status !== 'string')
    return '';

  return status.trim();
}

function shouldCleanupResponseFrame(status) {
  return status === 'forwarded' || status === 'null-response' || status === 'break';
}
