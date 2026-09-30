'use strict';

import { BaseFramePlugin } from '../../routing/index.mjs';
import {
  mergeMentionMaps,
  resolveMentionActors,
} from '../../mentions/index.mjs';
import { normalizeProviderUsage } from '../../tokens/index.mjs';

import {
  delayMsToClockUnits,
  normalizeStringArray,
  resolveCoordinatorAgentID,
  resolveService,
  sanitizeParticipantAgent,
} from './normalize.mjs';
import { createResponseAgentRoute } from './targeting.mjs';
import {
  mergeFrameUsage,
  resolveTokenServiceKey,
} from './usage.mjs';
import {
  createMessageDoneFrame,
  isClosedFrame,
  isClosingAgentMessageFrame,
  normalizeClosingFrame,
  normalizeProviderContent,
  shouldSuppressBlankAgentMessage,
} from './frame-content.mjs';
import {
  DEFAULT_CONTINUATION_PROMPT,
  buildContinuationPromptText,
  normalizeContinuation,
  normalizeContinuationDelay,
} from './continuation.mjs';

export class AgentRouteFramePluginBase extends BaseFramePlugin {
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

  async loadAgentTodoState({ agent, services = {} }) {
    let store = resolveService(services, 'agentTodoStore');
    if (!agent?.id || typeof store?.getTodoState !== 'function')
      return null;

    return await store.getTodoState(agent.id);
  }

  async loadAgentCwdState({ agent, services = {}, session = null }) {
    let store = resolveService(services, 'agentCwdStore');
    if (!agent?.id || !session?.id || typeof store?.getCWD !== 'function')
      return null;

    return await store.getCWD(agent.id, session.id);
  }

  providerServices({ services, agent, frame }) {
    let tokenUsage = resolveService(services, 'tokenUsage');
    return {
      ...services,
      frameEngine: this.context.engine,
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
    let responseFrame = this.context.engine.get(responseFrameID);
    if (output.phantom && isClosedFrame(responseFrame))
      return;

    let content = normalizeProviderContent(output, responseFrame);
    if (shouldSuppressBlankAgentMessage(output, content)) {
      if (!output.id || output.id === responseFrameID)
        this.cleanupResponseFrame({ responseFrameID, responseFrame, agent, status: 'empty' });

      return;
    }

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

    let frames = [ normalizeClosingFrame(mergedFrame, { now }) ];
    if (isClosingAgentMessageFrame(mergedFrame)) {
      frames.push(createMessageDoneFrame({
        agent,
        frame,
        responseFrameID,
        responseFrame: frames[0],
        now,
      }));
    }

    this.context.engine.merge(frames, {
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

  async scheduleAgentContinuation({ agent, frame, responseFrameID, continuation, services = {} }) {
    let delayMs = normalizeContinuationDelay(continuation.delayMs);
    let now = this.clock();
    let scheduledAt = now + delayMsToClockUnits(delayMs, now);
    let schedule = {
      agentID: agent.id,
      responseFrameID,
      sourceFrameID: frame.id,
      delayMs,
      continuationPrompt: continuation.continuationPrompt || DEFAULT_CONTINUATION_PROMPT,
      scheduledAt,
    };
    return await this.createScheduledAgentContinuationFrame({
      agent,
      frame,
      responseFrameID,
      continuation: schedule,
      services,
    });
  }

  async createScheduledAgentContinuationFrame({ agent, frame, responseFrameID, continuation, services = {} }) {
    let responseFrame = this.context.engine.get(responseFrameID);
    if (!responseFrame || responseFrame.deleted === true)
      return null;

    let now = this.clock();
    let continuationFrame = {
      id: this.context.engine.idGenerator(),
      type: 'UserMessage',
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: responseFrameID,
      authorType: 'system',
      authorID: 'internal:agent-continuation',
      targetAgentID: agent.id,
      timestamp: continuation.scheduledAt,
      createdAt: now,
      updatedAt: now,
      scheduledAt: continuation.scheduledAt,
      scheduledStatus: 'pending',
      hidden: true,
      deleted: false,
      continuation: {
        ...continuation,
        kind: 'agent-respond-and-continue',
        createdAt: now,
      },
      content: {
        text: buildContinuationPromptText({ agent, responseFrame, continuation }),
        status: 'scheduled',
        agentID: agent.id,
        agentName: agent.name || agent.id,
        sourceFrameID: frame.id,
        responseFrameID,
        continuationPrompt: continuation.continuationPrompt || DEFAULT_CONTINUATION_PROMPT,
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
