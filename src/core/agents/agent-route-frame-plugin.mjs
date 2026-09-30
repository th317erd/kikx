'use strict';

import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';

import {
  normalizeDoneStatus,
  normalizeStringArray,
  resolveCoordinatorAgentID,
  resolveService,
  shouldCleanupResponseFrame,
} from './agent-route/normalize.mjs';
import {
  filterRedundantRouteTargets,
  resolveRouteTargets,
  shouldRouteToAgents,
} from './agent-route/targeting.mjs';
import { totalTokensUsed } from './agent-route/usage.mjs';
import { normalizeContinuation } from './agent-route/continuation.mjs';
import { AgentRouteFramePluginBase } from './agent-route/agent-route-frame-plugin-base.mjs';

export class AgentRouteFramePlugin extends AgentRouteFramePluginBase {
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

    let routeTargets = filterRedundantRouteTargets({
      frame,
      routeTargets: resolveRouteTargets({ frame, participantAgentIDs, coordinatorAgentID }),
      frameEngine: this.context.engine,
    });
    if (routeTargets.length === 0) {
      await next(this.context);
      return;
    }

    let routeTasks = routeTargets.map((agentID) => this.routeAgent({
      agentID,
      coordinatorAgentID,
      agentManager,
      pluginRegistry,
      services,
      frame,
    }));
    let frameRouter = resolveService(services, 'frameRouter') || services?.frameRuntime?.frameRouter;

    if (typeof frameRouter?.runBackground === 'function') {
      for (let task of routeTasks)
        frameRouter.runBackground(task);
    } else {
      let results = await Promise.allSettled(routeTasks);
      for (let result of results) {
        if (result.status === 'rejected')
          this.logger.error?.('AgentRouteFramePlugin routeAgent failed', result.reason);
      }
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

      let participantAgents = await this.loadParticipantAgents({
        participantAgentIDs: this.context.session?.participantAgentIDs,
        agentManager,
        currentAgent: agent,
      });
      let sessionFrames = typeof this.context.engine.toArray === 'function'
        ? projectFrameMessages(this.context.engine.toArray())
        : [];
      let compactionService = resolveService(services, 'compactionService');
      let contextMemory = null;
      if (typeof compactionService?.prepareAgentContext === 'function') {
        contextMemory = await compactionService.prepareAgentContext({
          session: this.context.session,
          frameEngine: this.context.engine,
          triggerFrame: frame,
          agent,
          participantAgents,
          services,
          routerContext: this.context,
          coordinatorAgentID,
        });
        if (Array.isArray(contextMemory?.frames))
          sessionFrames = contextMemory.frames;
      }

      responseFrameID = this.context.engine.idGenerator();
      let responseFrame = await this.createResponseFrame({ agent, frame, responseFrameID, services });
      let tokenUsage = resolveService(services, 'tokenUsage');
      let tokenUsageSnapshot = typeof tokenUsage?.snapshot === 'function' ? tokenUsage.snapshot() : {};
      let todoState = await this.loadAgentTodoState({ agent, services });
      let cwdState = await this.loadAgentCwdState({ agent, services, session: this.context.session });
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
        contextMemory,
        tokenUsage: tokenUsageSnapshot,
        todoState,
        cwdState,
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

          break;
        }

        this.mergeProviderFrame(output, { agent, frame, responseFrameID });
      }

      if (continuation && responseFrameID)
        await this.scheduleAgentContinuation({ agent, frame, responseFrameID, continuation, services });

      return { status: doneStatus };
    } catch (error) {
      this.appendAgentError({
        agent: agent || { id: agentID, name: agentID },
        frame,
        error,
        responseFrameID,
      });
      await services?.frameRuntime?.frameStore?.flush?.();

      return { status: 'error' };
    }
  }
}

export function registerAgentRouting(frameRouter) {
  if (!frameRouter?.registerSelector)
    throw new TypeError('registerAgentRouting() requires a FrameRouter');

  frameRouter.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
  frameRouter.registerSelector('Type:AgentMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
}
