'use strict';

// =============================================================================
// InteractionController — sendMessage, cancel, approve, deny
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class InteractionController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact
  // ---------------------------------------------------------------------------

  async sendMessage({ params, body }) {
    let { message, agentId } = body || {};

    if (!message)
      this.throwBadRequestError('message is required');

    if (!agentId)
      this.throwBadRequestError('agentId is required');

    let { Agent }       = this.getCoreModels();
    let core            = this.getCore();
    let keystore        = this.getKeystore();
    let interactionLoop = this.getInteractionLoop();

    // Look up agent
    let agent = await Agent.where.id.EQ(agentId).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    // Get agent plugin class and instantiate
    let AgentClass = core.getAgentType(agent.pluginID);
    if (!AgentClass)
      this.throwBadRequestError(`No agent plugin registered for: ${agent.pluginID}`);

    let agentPlugin = new AgentClass(core.getContext());

    // Resolve API key if encrypted
    let resolvedAgent = { ...agent.toJSON ? agent.toJSON() : agent };
    if (agent.encryptedAPIKey) {
      try {
        let umk       = this.request.getUMK();
        let userKey   = keystore.deriveUserKey(umk, this.request.userId);
        let encrypted = JSON.parse(agent.encryptedAPIKey);

        resolvedAgent.apiKey = keystore.decrypt(encrypted, userKey).toString('utf8');
      } catch (_error) {
        this.throwBadRequestError('Failed to decrypt agent API key');
      }
    }

    // Build permission + tool execution callbacks
    let permissionEngine = core.getPermissionEngine();
    let pluginRegistry   = core.getPluginRegistry();

    let checkPermission = async (toolName, toolArgs) => {
      if (!permissionEngine)
        return true; // No engine = needs approval

      return permissionEngine.checkPermission(toolName, toolArgs, {
        organizationID: agent.organizationID,
        scope:          'session',
        scopeID:        params.sessionId,
      });
    };

    let executeTool = async (toolName, toolArgs) => {
      let ToolClass = pluginRegistry.getTool(toolName);
      if (!ToolClass)
        throw new Error(`Unknown tool: ${toolName}`);

      let toolInstance = new ToolClass(core.getContext());

      return toolInstance.execute(toolArgs);
    };

    // Start interaction (non-blocking — frames emitted via SSE)
    let interactionID = await interactionLoop.startInteraction(params.sessionId, {
      agentPlugin,
      agent:       resolvedAgent,
      userMessage: message,
      authorType:  'user',
      authorID:    this.request.userId,
      checkPermission,
      executeTool,
    });

    this.setStatusCode(202);

    return { data: { interactionID } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact/cancel
  // ---------------------------------------------------------------------------

  async cancel({ params }) {
    let interactionLoop = this.getInteractionLoop();
    let queued          = await interactionLoop.cancelInteraction(params.sessionId);

    return { data: { cancelled: true, queuedMessages: queued } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact/approve/:frameId
  // ---------------------------------------------------------------------------

  async approve({ params }) {
    let interactionLoop = this.getInteractionLoop();

    let interactionID = await interactionLoop.approvePermission(
      params.sessionId,
      params.frameId,
    );

    return { data: { approved: true, interactionID } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact/deny/:frameId
  // ---------------------------------------------------------------------------

  async deny({ params }) {
    let interactionLoop = this.getInteractionLoop();

    await interactionLoop.denyPermission(
      params.sessionId,
      params.frameId,
    );

    return { data: { denied: true } };
  }
}
