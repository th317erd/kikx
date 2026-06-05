'use strict';

import { BaseFramePlugin } from '../routing/index.mjs';

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

    let services = this.context.services || {};
    let agentManager = resolveService(services, 'agentManager');
    let pluginRegistry = resolveService(services, 'pluginRegistry');

    if (!agentManager)
      throw new Error('AgentRouteFramePlugin requires agentManager');

    if (!pluginRegistry)
      throw new Error('AgentRouteFramePlugin requires pluginRegistry');

    for (let agentID of participantAgentIDs)
      await this.routeAgent({ agentID, agentManager, pluginRegistry, services, frame });

    done();
  }

  async routeAgent({ agentID, agentManager, pluginRegistry, services, frame }) {
    let agent;
    let responseFrameID = null;
    try {
      agent = await agentManager.getAgent(agentID, { includeSecrets: true });
      if (!agent?.id)
        throw new Error(`Unknown agent: ${agentID}`);

      if (agent.enabled === false)
        return;

      let ProviderClass = pluginRegistry.getAgentProvider(agent.pluginID);
      if (!ProviderClass)
        throw new Error(`Unknown agent provider: ${agent.pluginID}`);

      responseFrameID = this.context.engine.idGenerator();
      let responseFrame = await this.createResponseFrame({ agent, frame, responseFrameID, services });
      let sessionFrames = typeof this.context.engine.toArray === 'function'
        ? this.context.engine.toArray()
        : [];
      let provider = new ProviderClass({
        ...this.context,
        agent,
        services,
      });
      let runParams = {
        frame,
        userFrame: frame,
        session: this.context.session,
        agent,
        config: agent.config || {},
        secrets: agent.secrets || {},
        frames: sessionFrames,
        sessionFrames,
        services,
        responseFrameID,
        responseFrame,
      };

      for await (let output of provider.run(runParams))
        this.mergeProviderFrame(output, { agent, frame, responseFrameID });
    } catch (error) {
      this.appendAgentError({
        agent: agent || { id: agentID, name: agentID },
        frame,
        error,
        responseFrameID,
      });
    }
  }

  async createResponseFrame({ agent, frame, responseFrameID, services }) {
    let now = this.clock();
    let responseFrame = {
      id: responseFrameID,
      type: 'AgentMessage',
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: frame.id,
      authorType: 'agent',
      authorID: agent.id,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      hidden: true,
      deleted: false,
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
      timestamp: output.timestamp || now,
      createdAt: output.createdAt || now,
      updatedAt: output.updatedAt || now,
      hidden: output.hidden ?? (output.phantom ? true : false),
      deleted: output.deleted ?? false,
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
    this.context.engine.merge([{
      id: responseFrameID || this.context.engine.idGenerator(),
      type,
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: frame.id,
      authorType: 'agent',
      authorID: agent.id,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      hidden: false,
      deleted: false,
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

  clock() {
    return this.context.services?.clock?.() || Date.now();
  }
}

export function registerAgentRouting(frameRouter) {
  if (!frameRouter?.registerSelector)
    throw new TypeError('registerAgentRouting() requires a FrameRouter');

  frameRouter.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
}

function shouldRouteToAgents(context, frame) {
  if (context.change?.operation && context.change.operation !== 'create')
    return false;

  if (frame?.type !== 'UserMessage')
    return false;

  let text = frame.content?.text;
  if (typeof text === 'string' && text.trim().startsWith('/'))
    return false;

  return true;
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
