'use strict';

// =============================================================================
// InteractionController — sendMessage, cancel, approve, deny
// =============================================================================

import { ControllerAuthBase }   from './controller-auth-base.mjs';

export class InteractionController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // _loadUserSigningKeys — best-effort user key loading for frame signing
  // ---------------------------------------------------------------------------
  // Attempts to load the authenticated user's Ed25519 signing keys by:
  //   1. Looking up the User record by userID
  //   2. Getting the UMK from the request vault claim
  //   3. Decrypting encryptedPrivateKey with keystore.decryptUserPrivateKey()
  //
  // Returns { privateKey, publicKey } or { privateKey: null, publicKey: null }.
  // Never throws — frame signing is best-effort and must not block delivery.
  // ---------------------------------------------------------------------------

  async _loadUserSigningKeys() {
    try {
      let umk = this.request.getUMK();
      if (!umk)
        return { privateKey: null, publicKey: null };

      let userID = this.request.userID;
      if (!userID)
        return { privateKey: null, publicKey: null };

      let { User } = this.getCoreModels();
      let user     = await User.where.id.EQ(userID).first();

      if (!user || !user.encryptedPrivateKey)
        return { privateKey: null, publicKey: user ? user.publicKey || null : null };

      let keystore   = this.getKeystore();
      let envelope   = JSON.parse(user.encryptedPrivateKey);
      let privateKey = keystore.decryptUserPrivateKey(envelope, umk, userID);

      return { privateKey, publicKey: user.publicKey || null };
    } catch (_error) {
      // Best-effort: decryption failure must not break message delivery
      return { privateKey: null, publicKey: null };
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact
  // ---------------------------------------------------------------------------

  async sendMessage({ params, body }) {
    let { message, agentID, parentID, convertMarkdown } = body || {};

    if (!message)
      this.throwBadRequestError('message is required');

    let interactionLoop = this.getInteractionLoop();

    // Load user signing keys for frame signing (best-effort; null if unavailable)
    let { privateKey: userPrivateKey, publicKey: userPublicKey } = await this._loadUserSigningKeys();

    // When no agent is specified, just persist the message and broadcast.
    // This supports sessions with no agents, or users chatting to each other.
    if (!agentID) {
      let result = await interactionLoop.postMessage(params.sessionID, {
        text:       message,
        authorType: 'user',
        authorID:   this.request.userID,
        parentID,
        convertMarkdown,
        userPrivateKey,
        userPublicKey,
      });

      this.setStatusCode(201);

      return { data: { interactionID: result.interactionID, frameID: result.frameID } };
    }

    let { Agent }       = this.getCoreModels();
    let core            = this.getCore();
    let keystore        = this.getKeystore();

    // Look up agent
    let agent = await Agent.where.id.EQ(agentID).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    // Get agent plugin class and instantiate
    let AgentClass = core.getAgentType(agent.pluginID);
    if (!AgentClass)
      this.throwBadRequestError(`No agent plugin registered for: ${agent.pluginID}`);

    let agentPlugin = new AgentClass(core.getContext());

    // Resolve API key if encrypted
    let resolvedAgent = { ...agent.toJSON ? agent.toJSON() : agent };

    // Preserve behaviors/config convenience methods for PrimerAssembler
    // and post-truncation re-injection (same as AgentResolver does)
    if (typeof agent.hasBehaviors === 'function') {
      resolvedAgent.hasBehaviors = () => agent.hasBehaviors();
      resolvedAgent.getBehaviors = () => agent.getBehaviors();
      resolvedAgent.getConfig    = () => agent.getConfig();
    }

    if (agent.encryptedAPIKey) {
      try {
        let umk       = this.request.getUMK();
        let userKey   = keystore.deriveUserKey(umk, this.request.userID);
        let encrypted = JSON.parse(agent.encryptedAPIKey);

        resolvedAgent.apiKey = keystore.decrypt(encrypted, userKey).toString('utf8');
      } catch (_error) {
        this.throwBadRequestError('Failed to decrypt agent API key');
      }
    }

    // Build tool execution callback
    let pluginRegistry = core.getPluginRegistry();

    // Permission checking is now handled inside each tool's execute() ->
    // _checkPermissions() pipeline (tool-owned permissions). This callback
    // exists only as a passthrough for user-typed slash commands handled by
    // CommandHandler, which don't go through PluginInterface.execute().
    let checkPermission = async (_featureName, _toolArgs) => {
      return false; // Always allow — tool internals handle permission gating
    };

    let executeTool = async (toolName, toolArgs) => {
      let ToolClass = pluginRegistry.getTool(toolName);

      if (!ToolClass) {
        // Try capabilities before giving up
        let capability = pluginRegistry.getCapability(toolName);
        if (capability) {
          let result = await capability.handler({
            params:     toolArgs,
            sessionID:  params.sessionID,
            context:    core.getContext(),
            authorType: 'agent',
            authorID:   this.request.userID,
            agent:      resolvedAgent,
          });

          if (result && result.injectPrimer)
            interactionLoop.requestPrimerRefresh(params.sessionID);

          return (result && result.content) || result;
        }

        throw new Error(`Unknown tool: ${toolName}`);
      }

      let toolInstance = new ToolClass(core.getContext());

      // Inject session/agent context into all tool calls
      let augmentedArgs = {
        ...toolArgs,
        _sessionID: params.sessionID,
        _authorID:  this.request.userID,
        _agent:     resolvedAgent,
      };

      // Inject agentID for tools that need to identify the calling agent
      if (resolvedAgent && resolvedAgent.id)
        augmentedArgs.agentID = toolArgs.agentID || resolvedAgent.id;

      let result = await toolInstance.execute(augmentedArgs);

      if (result && result.injectPrimer)
        interactionLoop.requestPrimerRefresh(params.sessionID);

      return result;
    };

    // Stash resolve context on the scheduler so it can decrypt API keys
    // for re-triggered or secondary agents.
    let sessionManager   = this.getSessionManager();
    let sessionScheduler = this.getSessionScheduler();
    let participants     = await sessionManager.getParticipants(params.sessionID);
    let agentCount       = (participants && participants.length > 0) ? participants.length : 1;

    if (sessionScheduler) {
      let umk = this.request.getUMK();
      sessionScheduler.setResolveContext(params.sessionID, {
        keystore,
        umk,
        userID: this.request.userID,
      });

      // Mark the primary agent as active BEFORE starting the interaction,
      // so the scheduling plugin's onCommit skips it (prevents double-trigger).
      sessionScheduler.markActive(params.sessionID, agentID);
    }

    // Start interaction (non-blocking — frames emitted via SSE)
    let interactionID = await interactionLoop.startInteraction(params.sessionID, {
      agentPlugin,
      agent:          resolvedAgent,
      userMessage:    message,
      authorType:     'user',
      authorID:       this.request.userID,
      agentCount,
      parentID,
      convertMarkdown,
      checkPermission,
      executeTool,
      userPrivateKey,
      userPublicKey,
    });

    this.setStatusCode(202);

    return { data: { interactionID } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact/cancel
  // ---------------------------------------------------------------------------

  async cancel({ params }) {
    let interactionLoop = this.getInteractionLoop();
    let queued          = await interactionLoop.cancelInteraction(params.sessionID);

    return { data: { cancelled: true, queuedMessages: queued } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact/approve/:frameID
  // ---------------------------------------------------------------------------
  // Unified approve/deny endpoint. Accepts optional { decisions } body:
  //   decisions: [{ command: 'ls', decision: 'allow-forever' }, ...]
  //
  // Decision values: 'allow-once', 'allow-forever', 'deny-once', 'deny-forever'
  //
  // If any decision is deny-once or deny-forever → marks frame as denied
  // Otherwise → marks frame as approved (processed=true)
  // Forever decisions create session-scoped permission rules.
  // No body / empty decisions → approve-all (backward compat)
  //
  // The FrameRouter + PermissionApprovalPlugin handle re-execution or denial
  // after the frame is saved.
  // ---------------------------------------------------------------------------

  async approve({ params, body }) {
    let decisions = (body && Array.isArray(body.decisions)) ? body.decisions : [];
    let hasDeny   = decisions.some((d) => d.decision === 'deny-once' || d.decision === 'deny-forever');

    // Create persistent rules for "forever" decisions
    if (decisions.length > 0) {
      let core             = this.getCore();
      let permissionEngine = core.getPermissionEngine();

      if (permissionEngine) {
        // Use the authenticated user's organization from JWT
        let organizationID = this.request.organizationID;

        for (let decision of decisions) {
          if (!decision.command || !decision.decision)
            continue;

          let effect = null;
          if (decision.decision === 'allow-forever')
            effect = 'allow';
          else if (decision.decision === 'deny-forever')
            effect = 'deny';

          if (!effect)
            continue; // allow-once / deny-once create no rules

          await permissionEngine.createRule({
            organizationID,
            featureName: (decision.command.includes(':')) ? decision.command : `shell:${decision.command}`,
            effect,
            scope:       'session',
            scopeID:     params.sessionID,
            createdBy:   this.request.userID,
            metadata:    {
              command:   decision.command,
              arguments: decision.arguments || [],
            },
          });
        }
      }
    }

    // Look up the permission-request frame
    let { Frame } = this.getCoreModels();
    let frame     = await Frame.where.id.EQ(params.frameID).first();

    if (!frame || frame.type !== 'PermissionRequest') {
      this.setStatusCode(410);

      return { data: { error: 'expired', message: 'This permission request has expired. Please resend your message to try again.' } };
    }

    // Already processed — idempotent
    if (frame.processed)
      return { data: hasDeny ? { denied: true } : { approved: true } };

    // Mark the frame as processed; set denied marker for denials
    frame.processed   = true;
    frame.processedAt = Date.now();

    if (hasDeny) {
      let content    = (typeof frame.getContent === 'function') ? frame.getContent() : (frame.content || {});
      content.denied = true;
      frame.content  = JSON.stringify(content);
    }

    await frame.save();

    // The FrameRouter will pick up the saved frame and route it through
    // the PermissionApprovalPlugin, which handles tool re-execution or
    // denial frame creation + interaction restart.

    if (hasDeny)
      return { data: { denied: true } };

    return { data: { approved: true } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact/deny/:frameID
  // ---------------------------------------------------------------------------

  async deny({ params }) {
    let { Frame } = this.getCoreModels();
    let frame     = await Frame.where.id.EQ(params.frameID).first();

    if (!frame || frame.type !== 'PermissionRequest') {
      this.setStatusCode(410);

      return { data: { error: 'expired', message: 'This permission request has expired. Please resend your message to try again.' } };
    }

    // Already processed — idempotent
    if (frame.processed)
      return { data: { denied: true } };

    // Mark as denied
    let content    = (typeof frame.getContent === 'function') ? frame.getContent() : (frame.content || {});
    content.denied = true;
    frame.content  = JSON.stringify(content);
    frame.processed   = true;
    frame.processedAt = Date.now();
    await frame.save();

    return { data: { denied: true } };
  }
}
