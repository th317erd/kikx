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
    try {
      agent = await agentManager.getAgent(agentID, { includeSecrets: true });
      if (!agent?.id)
        throw new Error(`Unknown agent: ${agentID}`);

      if (agent.enabled === false)
        return;

      let ProviderClass = pluginRegistry.getAgentProvider(agent.pluginID);
      if (!ProviderClass)
        throw new Error(`Unknown agent provider: ${agent.pluginID}`);

      let responseFrameID = this.context.engine.idGenerator();
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
        services,
        responseFrameID,
      };

      for await (let output of provider.run(runParams))
        this.mergeProviderFrame(output, { agent, frame, responseFrameID });
    } catch (error) {
      this.appendAgentError({
        agent: agent || { id: agentID, name: agentID },
        frame,
        error,
      });
    }
  }

  mergeProviderFrame(output, { agent, frame, responseFrameID }) {
    if (!output || output.type === 'Done')
      return;

    let now = this.clock();
    let mergedFrame = {
      ...output,
      id: output.id || (output.phantom ? this.context.engine.idGenerator() : responseFrameID),
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
    };

    this.context.engine.merge([ mergedFrame ], {
      authorType: 'agent',
      authorID: agent.id,
    });
  }

  appendAgentError({ agent, frame, error }) {
    let now = this.clock();
    this.context.engine.merge([{
      id: this.context.engine.idGenerator(),
      type: 'AgentError',
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
