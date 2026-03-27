'use strict';

// =============================================================================
// InteractionController — sendMessage, cancel, approve, deny
// =============================================================================

import { ControllerAuthBase }     from './controller-auth-base.mjs';
import { computeKeyFingerprint } from '../../core/crypto/value-signing.mjs';

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

    // Note: Persistent rules for "forever" decisions are created further
    // below (after execution) so they are only created once per approval.

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

    // Read frame content for signing
    let content = (typeof frame.getContent === 'function') ? frame.getContent() : (frame.content || {});

    // Sign the approval/denial with user's Ed25519 private key (best-effort)
    let action = (hasDeny) ? 'deny' : 'approve';

    try {
      let keystore = this.getKeystore();
      let { privateKey, publicKey } = await this._loadUserSigningKeys();

      if (privateKey && keystore) {
        let payload = JSON.stringify(keystore.canonicalize({
          action,
          frameID:   params.frameID,
          toolName:  content.toolName || null,
          arguments: content.arguments || {},
          sessionID: params.sessionID,
        }));

        let signature   = keystore.signWithPrivateKey(payload, privateKey);
        let fingerprint = computeKeyFingerprint(publicKey);

        if (hasDeny) {
          content.denialSignature   = signature;
          content.denialFingerprint = fingerprint;
          content.deniedBy          = this.request.userID;
        } else {
          content.approvalSignature   = signature;
          content.approvalFingerprint = fingerprint;
          content.approvedBy          = this.request.userID;
        }
      }
    } catch (_signError) {
      // Best-effort: signing failure must not block approval/denial
    }

    // Mark the frame as processed; set denied marker for denials
    frame.processed   = true;
    frame.processedAt = Date.now();

    if (hasDeny)
      content.denied = true;

    // Set the resolve context so the PermissionApprovalPlugin can decrypt
    // the agent's API key when it starts the replay interaction. The UMK
    // is only available during HTTP requests (from the JWT), so we must
    // stash it before the FrameRouter fires.
    let core             = this.getCore();
    let sessionScheduler = core.getContext().getProperty('sessionScheduler');

    if (sessionScheduler) {
      let keystore = this.getKeystore();
      let umk      = this.request.getUMK();

      if (umk && keystore) {
        sessionScheduler.setResolveContext(params.sessionID, {
          keystore,
          umk,
          userID: this.request.userID,
        });
      }
    }

    // Parse state and update the frame via FrameManager (no direct .save())
    let stateObj = null;
    try {
      stateObj = (typeof frame.state === 'string') ? JSON.parse(frame.state) : (frame.state || {});
    } catch (_e) {
      stateObj = {};
    }

    stateObj.step = hasDeny ? 'denied' : 'completed';

    let interactionLoop = core.getContext().getProperty('interactionLoop');
    await interactionLoop.updateFrame(params.sessionID, {
      id:          frame.id,
      processed:   true,
      processedAt: Date.now(),
      hidden:      true,
      state:       JSON.stringify(stateObj),
      content,
    });

    // -----------------------------------------------------------------------
    // Execute the decision
    // -----------------------------------------------------------------------
    // The placeholder ToolResult (created when permission was requested) stays
    // VISIBLE and paired with its ToolCall. On approval/denial, we UPDATE its
    // content with the real output. No hidden frames, no orphan conflicts.
    // -----------------------------------------------------------------------

    let toolName       = stateObj.toolName || 'unknown';
    let toolArguments  = stateObj.toolArguments || {};
    let sessionID      = stateObj.sessionID || params.sessionID;
    let agentID        = stateObj.agentID;
    let toolUseID      = stateObj.toolUseID;
    let toolResultID   = stateObj.toolResultID; // Set by InteractionLoop when creating the placeholder

    // Create "forever" PermissionRules for allow-forever / deny-forever decisions
    try {
      let { Permissions } = await import('../../core/permissions/permissions-base.mjs');
      let permissions     = new Permissions(core.getContext());
      let organizationID  = this.request.organizationID;

      for (let decision of decisions) {
        if (!decision.command || !decision.decision)
          continue;

        let effect = null;
        if (decision.decision === 'allow-forever')
          effect = 'allow';
        else if (decision.decision === 'deny-forever')
          effect = 'deny';

        if (!effect)
          continue;

        let featureName = decision.command.includes(':') ? decision.command : `shell:${decision.command}`;

        await permissions.createRule({
          organizationID,
          featureName,
          effect,
          scope:     'session',
          scopeID:   sessionID,
          createdBy: this.request.userID || 'system',
          metadata:  {
            command:   decision.command,
            arguments: decision.arguments || [],
            permissionRequestID: frame.id,
          },
        });
      }
    } catch (ruleError) {
      console.error('[approve] Failed to create permission rule:', ruleError.message);
    }

    // Determine the tool output
    let toolResultOutput;

    if (hasDeny) {
      let isDenyForever = decisions.some((d) => d.decision === 'deny-forever');
      toolResultOutput  = isDenyForever
        ? `Permission permanently denied for "${toolName}". User denied execution for this tool in this session.`
        : `Permission denied for "${toolName}". User denied this specific request. Do not retry unless the user explicitly asks.`;
    } else {
      // Approval: execute the tool directly
      let pluginRegistry = core.getPluginRegistry();
      let ToolClass      = pluginRegistry.getTool(toolName);

      if (!ToolClass) {
        toolResultOutput = `Error: tool "${toolName}" not found. Cannot execute after approval.`;
      } else {
        try {
          let toolInstance = new ToolClass(core.getContext());
          let result       = await toolInstance._execute(toolArguments);

          if (result && typeof result === 'object' && result.content)
            result = result.content;

          toolResultOutput = (typeof result === 'string') ? result : JSON.stringify(result);
        } catch (execError) {
          toolResultOutput = `Error executing "${toolName}" after approval: ${execError.message}`;
        }
      }
    }

    // UPDATE the existing placeholder ToolResult with the real output.
    // No new frame, no hidden/unhide dance. The ToolCall-ToolResult pair stays intact.
    let { Frame: FrameModel } = this.getCoreModels();

    try {
      let existingResult = null;

      // Find by stored ID (preferred)
      if (toolResultID)
        existingResult = await FrameModel.where.id.EQ(toolResultID).first();

      // Fallback: find by toolUseID match
      if (!existingResult && toolUseID) {
        let candidates = await FrameModel.where
          .sessionID.EQ(params.sessionID)
          .AND.type.EQ('ToolResult')
          .all();

        existingResult = candidates.find((f) => {
          let c = (typeof f.content === 'string') ? f.content : JSON.stringify(f.content || {});
          return c.includes(toolUseID);
        });
      }

      if (existingResult) {
        // Update via FrameManager — handles merge, persistence, SSE broadcast
        let updatedContent = {
          output:    toolResultOutput,
          toolUseID: toolUseID || null,
          _sessionID: sessionID,
        };

        let interactionLoop = core.getContext().getProperty('interactionLoop');
        if (interactionLoop) {
          await interactionLoop.updateFrame(sessionID, {
            id:      existingResult.id,
            content: updatedContent,
          });
        }
      } else {
        // No existing placeholder found — create via InteractionLoop._createFrame
        let interactionLoop = core.getContext().getProperty('interactionLoop');
        if (interactionLoop) {
          let XID            = (await import('xid-js')).default;
          let sessionManager = this.getSessionManager();
          let frameManager   = sessionManager.getFrameManager(sessionID);

          await interactionLoop._createFrame(sessionID, {
            id:            `frm_${XID.next()}`,
            type:          'ToolResult',
            content:       { output: toolResultOutput, toolUseID: toolUseID || null, _sessionID: sessionID },
            timestamp:     Date.now(),
            interactionID: stateObj.interactionID || null,
            authorType:    'system',
            hidden:        false, deleted: false, processed: false,
          }, frameManager);
        }
      }
    } catch (frameError) {
      console.error('[approve] Failed to update ToolResult:', frameError.message);
    }

    // Start a new interaction so the agent sees and responds to the tool result.
    // The resolveContext was stashed on the sessionScheduler above (lines 318-331)
    // so the AgentResolver can decrypt the agent's API key.
    // Use setTimeout to let the DB writes settle before starting the interaction.
    try {
      let agentResolver = core.getContext().getProperty('agentResolver');
      let interactionLoop = core.getContext().getProperty('interactionLoop');

      if (agentResolver && interactionLoop && agentID) {
        let resolveCtx = (sessionScheduler && sessionScheduler.getResolveContext)
          ? (sessionScheduler.getResolveContext(sessionID) || {})
          : {};

        setTimeout(async () => {
          try {
            let { agentPlugin, resolvedAgent } = await agentResolver.resolve(agentID, resolveCtx);
            let { checkPermission, executeTool } = agentResolver.buildCallbacks(resolvedAgent, sessionID);

            await interactionLoop.startInteraction(sessionID, {
              agentPlugin,
              agent:                resolvedAgent,
              userMessage:          null,
              authorType:           'agent',
              authorID:             agentID,
              checkPermission,
              executeTool,
              replayFromPermission: true,
            });
          } catch (startError) {
            console.error('[approve] Deferred startInteraction failed:', startError.message);
          }
        }, 300);
      }
    } catch (interactionError) {
      console.error('[approve] Failed to set up post-approval interaction:', interactionError.message);
    }

    return { data: hasDeny ? { denied: true } : { approved: true } };
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
    let content = (typeof frame.getContent === 'function') ? frame.getContent() : (frame.content || {});

    // Sign denial with user's Ed25519 private key (best-effort)
    try {
      let keystore = this.getKeystore();
      let { privateKey, publicKey } = await this._loadUserSigningKeys();

      if (privateKey && keystore) {
        let payload = JSON.stringify(keystore.canonicalize({
          action:    'deny',
          frameID:   params.frameID,
          toolName:  content.toolName || null,
          arguments: content.arguments || {},
          sessionID: params.sessionID,
        }));

        let signature   = keystore.signWithPrivateKey(payload, privateKey);
        let fingerprint = computeKeyFingerprint(publicKey);

        content.denialSignature   = signature;
        content.denialFingerprint = fingerprint;
        content.deniedBy          = this.request.userID;
      }
    } catch (_signError) {
      // Best-effort: signing failure must not block denial
    }

    content.denied = true;

    // Set resolve context for API key decryption during replay
    let core             = this.getCore();
    let sessionScheduler = core.getContext().getProperty('sessionScheduler');

    if (sessionScheduler) {
      let keystore = this.getKeystore();
      let umk      = this.request.getUMK();

      if (umk && keystore) {
        sessionScheduler.setResolveContext(params.sessionID, {
          keystore,
          umk,
          userID: this.request.userID,
        });
      }
    }

    // Save the denial via FrameManager (no direct .save())
    let stateObj = null;
    try {
      stateObj = (typeof frame.state === 'string') ? JSON.parse(frame.state) : (frame.state || {});
    } catch (_e) {
      stateObj = {};
    }

    stateObj.step = 'denied';

    let interactionLoop = core.getContext().getProperty('interactionLoop');
    await interactionLoop.updateFrame(params.sessionID, {
      id:          frame.id,
      content,
      processed:   true,
      processedAt: Date.now(),
      hidden:      true,
      state:       JSON.stringify(stateObj),
    });

    // UPDATE the existing placeholder ToolResult with denial message
    let toolName       = stateObj.toolName || content.toolName || 'unknown';
    let toolUseID      = stateObj.toolUseID || null;
    let toolResultID   = stateObj.toolResultID;
    let denialOutput   = `Permission denied for "${toolName}". User denied this specific request. Do not retry unless the user explicitly asks.`;

    let { Frame: DenyFrameModel } = this.getCoreModels();

    try {
      let existingResult = null;

      if (toolResultID)
        existingResult = await DenyFrameModel.where.id.EQ(toolResultID).first();

      if (!existingResult && toolUseID) {
        let candidates = await DenyFrameModel.where
          .sessionID.EQ(params.sessionID)
          .AND.type.EQ('ToolResult')
          .all();

        existingResult = candidates.find((f) => {
          let c = (typeof f.content === 'string') ? f.content : JSON.stringify(f.content || {});
          return c.includes(toolUseID);
        });
      }

      if (existingResult) {
        // Update via FrameManager — handles merge, persistence, SSE broadcast
        let updatedContent = {
          output:    denialOutput,
          toolUseID: toolUseID || null,
          _sessionID: params.sessionID,
        };

        if (interactionLoop) {
          await interactionLoop.updateFrame(params.sessionID, {
            id:      existingResult.id,
            content: updatedContent,
          });
        }
      } else {
        // Fallback: create via InteractionLoop._createFrame
        if (interactionLoop) {
          let XID            = (await import('xid-js')).default;
          let sessionManager = this.getSessionManager();
          let frameManager   = sessionManager.getFrameManager(params.sessionID);

          await interactionLoop._createFrame(params.sessionID, {
            id:            `frm_${XID.next()}`,
            type:          'ToolResult',
            content:       { output: denialOutput, toolUseID: toolUseID || null, _sessionID: params.sessionID },
            timestamp:     Date.now(),
            interactionID: stateObj.interactionID || null,
            authorType:    'system',
            hidden:        false, deleted: false, processed: false,
          }, frameManager);
        }
      }
    } catch (_denialError) {
      console.error('[deny] Failed to update denial ToolResult:', _denialError.message);
    }

    return { data: { denied: true } };
  }
}
