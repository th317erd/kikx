'use strict';

import { EventEmitter }          from 'node:events';
import { createHash }            from 'node:crypto';
import XID                       from 'xid-js';
import { PermissionDeniedError } from '../permissions/permission-denied-error.mjs';
import { PermissionHandler }     from './permission-handler.mjs';
import { CommandHandler }        from './command-handler.mjs';
import { isFirstMessage, injectPrimer, buildMessages } from './message-history.mjs';
import { truncateContent, truncateConversation }       from './context-truncation.mjs';
import { reinjectBehaviors }                            from './behaviors-reinjection.mjs';
import { reinjectInstructions }                        from './instructions-reinjection.mjs';
import { signFrameContent, decryptAgentPrivateKey }    from '../crypto/frame-signing.mjs';
import { computeKeyFingerprint }                       from '../crypto/value-signing.mjs';
import { ToolLogService }                              from './tool-log-service.mjs';
import { parseShellCommands }                          from '../internal-plugins/shell/command-parser.mjs';
import CompactionRunner                                from '../compaction/index.mjs';

// =============================================================================
// InteractionLoop
// =============================================================================
// The interaction kernel that drives agent-kernel communication via async
// generators. Manages the lifecycle of interactions: starting, iterating
// agent blocks, handling tool calls, permission hard-breaks, message
// queuing, and cancellation.
//
// Heavy subsystems are delegated to:
//   - PermissionHandler  (permission-handler.mjs)
//   - CommandHandler      (command-handler.mjs)
//   - message-history.mjs (buildMessages, isFirstMessage, injectPrimer)
// =============================================================================

function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

export class InteractionLoop extends EventEmitter {
  constructor(context) {
    super();

    if (!context)
      throw new Error('InteractionLoop requires a CascadingContext');

    this._context = context;

    // Active interactions: compositeKey -> { generator, interactionID, params }
    // Key is `${sessionID}:${agentID}` when agent present, or `sessionID` for backward compat
    this._active = new Map();

    // Message queues: compositeKey -> string[]
    this._queues = new Map();

    // Sessions needing primer on next interaction (set by /reload command)
    this._primerNeeded = new Set();

    // Delegated subsystems
    this._permissionHandler = new PermissionHandler(this);
    this._commandHandler    = new CommandHandler(this);

    // Tool log service (tool-log plan)
    this._toolLogService = new ToolLogService();

    // --- Compaction: runner instance ---
    this._compactionRunner = new CompactionRunner({ logger: console });
  }

  // ---------------------------------------------------------------------------
  // _activeKey — composite key for per-agent state maps
  // ---------------------------------------------------------------------------

  _activeKey(sessionID, agentID) {
    return (agentID) ? `${sessionID}:${agentID}` : sessionID;
  }

  // ---------------------------------------------------------------------------
  // Accessors — resolve dependencies lazily from context
  // ---------------------------------------------------------------------------

  _getSessionManager() {
    return this._context.getProperty('sessionManager');
  }

  _getFramePersistence() {
    return this._context.getProperty('framePersistence');
  }

  _getContentSanitizer() {
    return this._context.getProperty('contentSanitizer');
  }

  _getMarkdownConverter() {
    return this._context.getProperty('markdownConverter');
  }

  _getHookRunner() {
    // Prefer HookService (C4) over legacy HookRunner
    return this._context.getProperty('hookService') || this._context.getProperty('hookRunner');
  }

  _getKeystore() {
    return this._context.getProperty('keystore');
  }

  _getModels() {
    return this._context.getProperty('models');
  }

  _getToolLogService() {
    return this._toolLogService;
  }

  async _isDMForAgent(agent, sessionID) {
    if (!agent || !sessionID)
      return false;

    let models = this._context.getProperty('models');
    if (!models || !models.Session)
      return false;

    let session = await models.Session.where.id.EQ(sessionID).first();
    return session != null && session.dmAgentID === agent.id;
  }

  // ---------------------------------------------------------------------------
  // _signFrame — sign frame content before commit (best-effort)
  // ---------------------------------------------------------------------------
  // Determines the correct private key based on authorType and signs the frame
  // content. Uses cached agent/user keys from the signing context when available.
  // Also computes the signingKeyFingerprint (first 32 hex chars of SHA-256 of
  // the signer's public key PEM) for tamper-detection and key lookup.
  //
  // Returns { signature, fingerprint } on success, or null if signing is not
  // possible. Never throws.
  //
  // NOTE: This method is in the SIGNING CONTEXT section of InteractionLoop
  // (lines ~125-185). The truncation section is separate (~329-340).
  // ---------------------------------------------------------------------------

  _signFrame(frameData, signingContext) {
    let keystore = this._getKeystore();
    if (!keystore)
      return null;

    let authorType = frameData.authorType;
    let content    = frameData.content;

    if (authorType === 'system') {
      let signature   = signFrameContent(keystore, content, 'system', null);
      let fingerprint = computeKeyFingerprint(keystore.getSystemPublicKey());
      return (signature) ? { signature, fingerprint } : null;
    }

    if (authorType === 'agent' && signingContext && signingContext.agentPrivateKey) {
      let signature   = signFrameContent(keystore, content, 'agent', signingContext.agentPrivateKey);
      let fingerprint = computeKeyFingerprint(signingContext.agentPublicKey || null);
      return (signature) ? { signature, fingerprint } : null;
    }

    if (authorType === 'user' && signingContext && signingContext.userPrivateKey) {
      let signature   = signFrameContent(keystore, content, 'user', signingContext.userPrivateKey);
      let fingerprint = computeKeyFingerprint(signingContext.userPublicKey || null);
      return (signature) ? { signature, fingerprint } : null;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // _buildSigningContext — prepare cached signing keys for an interaction
  // ---------------------------------------------------------------------------
  // Called once per startInteraction(). Decrypts the agent private key (if
  // available) so it can be reused for every frame in the interaction without
  // repeated SMK-derived decryption. Also caches public keys for fingerprinting.
  // ---------------------------------------------------------------------------

  _buildSigningContext(params) {
    let keystore = this._getKeystore();
    if (!keystore)
      return null;

    let context = {};

    // Agent private key: decrypt once, cache for interaction lifetime
    let agent = params.agent;
    if (agent && agent.encryptedPrivateKey) {
      let agentPrivateKey = decryptAgentPrivateKey(keystore, agent.encryptedPrivateKey, agent.id);
      if (agentPrivateKey)
        context.agentPrivateKey = agentPrivateKey;
    }

    // Agent public key: cache for fingerprint computation
    if (agent && agent.publicKey)
      context.agentPublicKey = agent.publicKey;

    // User private key: passed in by caller (e.g., server decrypted via UMK)
    if (params.userPrivateKey)
      context.userPrivateKey = params.userPrivateKey;

    // User public key: passed in by caller for fingerprint computation
    if (params.userPublicKey)
      context.userPublicKey = params.userPublicKey;

    return context;
  }

  // ---------------------------------------------------------------------------
  // _storeAndMaybeReplaceToolOutput — tool-log plan interception hook
  // ---------------------------------------------------------------------------
  // Called after every tool execution, BEFORE creating the tool-result frame.
  // Stores the output in ValueStore via ToolLogService (best-effort).
  // If output exceeds 1024 Unicode characters, replaces toolOutput inline with
  // a JSON pointer message so the agent uses tool_log:get to retrieve it.
  // ---------------------------------------------------------------------------

  async _storeAndMaybeReplaceToolOutput(sessionID, interactionID, block, params, toolOutput, signingContext) {
    try {
      let toolLogService = this._getToolLogService();
      if (!toolLogService)
        return toolOutput;

      // Extract pluginID and toolName from "pluginID:toolName" format
      let fullToolName = block.content.toolName || '';
      let colonIdx     = fullToolName.indexOf(':');
      let pluginID     = colonIdx >= 0 ? fullToolName.slice(0, colonIdx) : '';
      let toolName     = colonIdx >= 0 ? fullToolName.slice(colonIdx + 1) : fullToolName;

      // Check if the tool opts out of storage via static skipToolLog = true.
      // Retrieval/search tools must skip storage to avoid infinite recursion:
      // search → store → pointer → get → store → pointer → ...
      let pluginRegistry = this._context.getProperty('pluginRegistry');
      if (pluginRegistry) {
        let ToolClass = pluginRegistry.getTool(fullToolName);
        if (ToolClass && ToolClass.skipToolLog)
          return toolOutput;
      }

      // Get agent info
      let agent          = params.agent;
      let agentID        = (agent && agent.id) || block.authorID || null;
      let organizationID = (agent && agent.organizationID) || null;

      // Get signing material from signingContext (agentPrivateKey) and agent model (publicKey)
      let privateKeyPEM = (signingContext && signingContext.agentPrivateKey) || null;
      let publicKeyPEM  = (agent && agent.publicKey) || null;
      let keystore      = this._getKeystore();

      // Get models
      let models = this._getModels();

      let storeResult = await toolLogService.storeToolOutput({
        sessionID,
        interactionID,
        agentID,
        organizationID,
        toolName,
        pluginID,
        toolCallArgs: block.content.arguments || null,
        output:       toolOutput,
        models,
        keystore,
        privateKeyPEM,
        publicKeyPEM,
      });

      // If output > 1024 Unicode chars, replace inline with pointer JSON
      let outputStr = (typeof toolOutput === 'string') ? toolOutput : JSON.stringify(toolOutput);
      let charCount = [ ...outputStr ].length;  // Unicode-aware character count

      if (charCount > 1024 && storeResult) {
        return JSON.stringify({
          stored:        true,
          tool_log_id:   storeResult.key,
          output_length: charCount,
          message:       'Output stored. Retrieve with tool_log:get.',
        });
      }

      return toolOutput;
    } catch (error) {
      // Best-effort — never block tool delivery
      console.error('[ToolLog] Failed to store tool output:', error.message || error);
      return toolOutput;
    }
  }

  // ---------------------------------------------------------------------------
  // _createFrame — routes frame creation through FrameManager for commits
  // ---------------------------------------------------------------------------

  async _createFrame(sessionID, frameData, frameManager, mergeOptions = {}, signingContext) {
    // Sign the frame content before commit (best-effort)
    // _signFrame returns { signature, fingerprint } or null.
    if (!frameData.signature) {
      let signResult = this._signFrame(frameData, signingContext);
      if (signResult) {
        frameData.signature            = signResult.signature;
        frameData.signingKeyFingerprint = signResult.fingerprint || null;
      }
    }

    let framePersistence = this._getFramePersistence();

    if (frameManager) {
      let results = frameManager.merge([frameData], mergeOptions);

      if (results.length === 0)
        return null; // Commit validator rejected

      await framePersistence.saveFrames(sessionID, [frameData]);
      this.emit('frame', { sessionID, frame: frameData });

      let latestCommit = frameManager.getLatestCommit();
      if (latestCommit) {
        // Enrich with frame data for wire transmission — client can merge() directly
        let enrichedCommit = {
          ...latestCommit,
          frames: [frameData],
        };

        this.emit('commit', { sessionID, commit: enrichedCommit });
      }

      return frameData;
    }

    // Fallback: direct persist (for contexts without a loaded FrameManager)
    await framePersistence.saveFrames(sessionID, [frameData]);
    this.emit('frame', { sessionID, frame: frameData });

    return frameData;
  }

  // ---------------------------------------------------------------------------
  // (removed: _replayApprovedToolCalls — tool execution now happens directly
  //  in the approval controller. No one-time rules or replay mechanism needed.)

  // ---------------------------------------------------------------------------
  // startInteraction
  // ---------------------------------------------------------------------------

  async startInteraction(sessionID, params = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    // If already running an interaction for this agent (or session), queue the message
    let agentID   = params.agent && params.agent.id;
    let activeKey = this._activeKey(sessionID, agentID);

    if (this._active.has(activeKey)) {
      if (params.userMessage)
        this.queueMessage(sessionID, params.userMessage, agentID);

      return null;
    }

    // Command dispatch: intercept /command messages
    let commandMatch = this._commandHandler.parse(params.userMessage);
    if (commandMatch)
      return this._commandHandler.execute(sessionID, params, commandMatch);

    let framePersistence = this._getFramePersistence();
    let hookRunner       = this._getHookRunner();
    let sessionManager   = this._getSessionManager();
    let interactionID    = generateID('int_');

    // Build signing context: decrypt agent private key once per interaction
    let signingContext = this._buildSigningContext(params);
    params = { ...params, _signingContext: signingContext };

    // Load FrameManager BEFORE creating any frames
    let frameManager = sessionManager.getFrameManager(sessionID);
    await framePersistence.loadFramesInto(frameManager, sessionID);

    // Auto-heal: hide orphaned tool-calls that have no matching tool-result.
    // These cause API errors and poison the conversation. Best-effort.
    await framePersistence.hideOrphanedFrames(sessionID);

    // Sync order counter with DB max to avoid order collisions
    let nextDbOrder = await framePersistence.getNextOrder(sessionID);
    frameManager.syncOrderCounter(nextDbOrder - 1);

    // Hook: user → agent (before agent execution)
    if (hookRunner && params.userMessage && !params.replayFromPermission) {
      let hookResult = await hookRunner.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: params.userMessage,
        context: { sessionID },
      });

      if (hookResult.action === 'block') {
        await this._createFrame(sessionID, {
          id:            generateID('frm_'),
          type:          'HookBlocked',
          content:       { reason: hookResult.reason || 'Message blocked by hook' },
          timestamp:     Date.now(),
          interactionID,
          authorType:    'system',
          authorID:      null,
          parentID:      params.parentID || null,
          hidden:        false,
          deleted:       false,
          processed:     false,
        }, frameManager, { authorType: 'system' }, signingContext);

        return interactionID;
      }

      params = { ...params, userMessage: hookResult.message };
    }

    // Create user message frame (unless replaying from permission approval)
    if (params.userMessage && !params.replayFromPermission) {
      // Optionally convert markdown → sanitized HTML
      let frameContent;

      if (params.convertMarkdown) {
        let converter = this._getMarkdownConverter();
        let html      = (converter) ? converter.convert(params.userMessage) : params.userMessage;
        frameContent  = { html };
      } else {
        frameContent = { text: params.userMessage };
      }

      await this._createFrame(sessionID, {
        id:            generateID('frm_'),
        type:          'UserMessage',
        content:       frameContent,
        timestamp:     Date.now(),
        interactionID,
        authorType:    params.authorType || 'user',
        authorID:      params.authorID || null,
        parentID:      params.parentID || null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      }, frameManager, { authorType: params.authorType || 'user', authorID: params.authorID || null }, signingContext);
    }

    // Build message history from existing frames
    let allFrames  = frameManager.toArray();
    let forAgentID = params.agent && params.agent.id;

    // --- Compaction: detect active compaction to filter message history ---
    let activeCompaction = null;
    for (let i = 0; i < allFrames.length; i++) {
      let frame = allFrames[i];
      if (frame.type === 'Compaction' && frame.content && frame.content.status === 'started') {
        activeCompaction = { order: frame.order, frameID: frame.id };
        break;
      }
    }

    let messages = buildMessages(allFrames, forAgentID, { activeCompaction });

    // =============================================================================
    // TRUNCATION — plugin-model-registry plan
    // Delegate truncation to plugin.truncate() for model-aware context budgeting.
    // plugin.truncate() calls standalone truncateContent/truncateConversation internally.
    // This section owns lines ~425-428. Frame-signing section owns lines ~132-181.
    // =============================================================================
    let truncPlugin = params.agentPlugin;
    if (truncPlugin && typeof truncPlugin.truncate === 'function') {
      messages = await truncPlugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    (params.agent && params.agent.behaviors) || '',
        instructionsText: (params.agent && params.agent.instructions) || '',
        onOverflow:       async (_type) => {
          await this._createFrame(sessionID, {
            id:            generateID('frm_'),
            type:          'SystemError',
            content:       { message: 'errors.behaviorsOverflow' },
            timestamp:     Date.now(),
            interactionID,
            authorType:    'system',
            authorID:      null,
            parentID:      params.parentID || null,
            hidden:        false,
            deleted:       false,
            processed:     false,
          }, frameManager, { authorType: 'system' }, signingContext);
        },
      });
    } else {
      // Fallback for plugins that don't implement truncate() yet
      messages = truncateContent(messages);
      messages = truncateConversation(messages);
    }

    // Inject primer for first message, explicit request, or new agent
    let primerRequested = this._primerNeeded.delete(sessionID);
    let agentRefExists  = forAgentID && frameManager.getRef(`processed/agent-${forAgentID}`) !== undefined;
    let needsPrimer     = params.injectPrimer || isFirstMessage(allFrames) || primerRequested || (forAgentID && !agentRefExists);

    if (needsPrimer) {
      let primerAssembler = this._context.getProperty('primerAssembler');
      if (primerAssembler) {
        let participants = await sessionManager.getParticipants(sessionID);
        let primer = await primerAssembler.assemble(params.agent, { sessionID, participants });
        if (primer)
          messages = injectPrimer(messages, primer);
      }
    }

    // Re-inject behaviors after truncation if primer was not injected this turn
    messages = await reinjectBehaviors(messages, params.agent, {
      primerInjected: needsPrimer,
      isDMForAgent:   () => this._isDMForAgent(params.agent, sessionID),
    });

    // Re-inject instructions after truncation if primer was not injected this turn
    messages = reinjectInstructions(messages, params.agent, {
      primerInjected: needsPrimer,
    });

    // --- Compaction: trigger check ---
    // Check if the agent plugin wants to compact the session history.
    // This is fire-and-forget -- the current interaction proceeds with truncation.
    let plugin = truncPlugin;
    if (plugin && typeof plugin.shouldCompact === 'function') {
      let totalChars      = messages.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0);
      let estimatedTokens = Math.ceil(totalChars / 3.5);
      let contextWindow   = (plugin.getContextWindow && plugin.getContextWindow()) || 200000;
      let modelID         = (plugin.getModelID && plugin.getModelID()) || 'unknown';

      let stats  = { totalChars, estimatedTokens, contextWindow, modelID, sessionID };
      let result = plugin.shouldCompact(stats);

      if (result && result.compact) {
        let canStart = await this._compactionRunner.canStartCompaction(sessionID, frameManager);
        if (canStart) {
          // Fire-and-forget -- do NOT await
          this._compactionRunner.runCompaction(sessionID, {
            agent: params.agent,
            plugin,
            frameManager,
            interactionLoop: this,
          }).catch((error) => {
            console.error('[compaction] failed:', error);
          });
        }
      }
    }

    // Ensure per-agent ref exists for scheduling/diff
    if (agentID)
      this._ensureAgentRef(frameManager, agentID);

    // Get session record and execute the agent
    let session   = await sessionManager.getSession(sessionID);
    let generator = await params.agentPlugin.execute({
      messages,
      agent:   params.agent,
      session,
      context: this._context,
    });

    // Track the active interaction (per-agent key)
    this._active.set(activeKey, {
      generator,
      interactionID,
      params,
      frameManager,
    });

    this.emit('interaction:start', { sessionID, interactionID, agentID: (params.agent && params.agent.id) || null });

    // Interaction-level safety: warn after 120s, force-end after 300s.
    // This prevents a single hung agent from permanently blocking a session.
    // Timeouts configurable via params for testing.
    let warnTimeout = params.interactionWarnTimeout || 120000;
    let killTimeout = params.interactionKillTimeout || 300000;

    let warningTimer = setTimeout(async () => {
      try {
        await this._createFrame(sessionID, {
          id: generateID('frm_'), type: 'Error',
          content: { message: 'The agent is taking an unusually long time to respond. You may need to retry your message.' },
          timestamp: Date.now(), interactionID,
          authorType: 'system', authorID: null,
          hidden: false, deleted: false, processed: false,
        }, frameManager, { authorType: 'system' }, signingContext);
      } catch (_e) {
        // Best-effort warning
      }
    }, warnTimeout);

    let killTimer = setTimeout(async () => {
      try {
        console.error(`[InteractionLoop] Force-ending interaction ${interactionID} after 300s timeout`);
        await generator.return();

        await this._createFrame(sessionID, {
          id: generateID('frm_'), type: 'Error',
          content: { message: 'The interaction was ended after 5 minutes with no response from the agent. Please try sending your message again.' },
          timestamp: Date.now(), interactionID,
          authorType: 'system', authorID: null,
          hidden: false, deleted: false, processed: false,
        }, frameManager, { authorType: 'system' }, signingContext);

        let agentID2   = params.agent && params.agent.id;
        let activeKey2 = this._activeKey(sessionID, agentID2);

        this._active.delete(activeKey2);
        this.emit('interaction:end', { sessionID, interactionID, agentID: agentID2 || null });
      } catch (_e) {
        console.error('[InteractionLoop] Force-end failed:', _e.message);
      }
    }, killTimeout);

    try {
      await this._iterateGenerator(sessionID, generator, interactionID, params, frameManager);
    } finally {
      clearTimeout(warningTimer);
      clearTimeout(killTimer);
    }

    return interactionID;
  }

  // ---------------------------------------------------------------------------
  // _iterateGenerator — the kernel loop
  // ---------------------------------------------------------------------------

  async _iterateGenerator(sessionID, generator, interactionID, params, frameManager) {
    let sanitizer      = this._getContentSanitizer();
    let hookRunner     = this._getHookRunner();
    let signingContext = params._signingContext || null;
    let result;

    try {
      while (true) {
        let { value: block, done } = await generator.next(result);
        result = undefined;

        if (done || !block)
          break;

        if (block.type === 'Done') {
          if (block.content && block.content.usage) {
            let agentID     = (params.agent && params.agent.id) || null;
            let serviceType = (params.agentPlugin && params.agentPlugin.constructor.serviceType) || 'unknown';

            this.emit('interaction:usage', {
              sessionID, interactionID, agentID, serviceType,
              usage:   block.content.usage,
              isFinal: true,
            });

            // Persist to tokens table
            this._persistTokenUsage(sessionID, interactionID, params, block.content.usage);
          }

          break;
        }

        // Transient streaming events — not persisted, just forwarded
        if (block.type === 'Delta') {
          this.emit('Delta', {
            sessionID, interactionID,
            content: block.content, authorType: block.authorType, authorID: block.authorID,
          });
          continue;
        }

        if (block.type === 'ReflectionDelta') {
          this.emit('ReflectionDelta', {
            sessionID, interactionID,
            content: block.content, authorType: block.authorType, authorID: block.authorID,
          });
          continue;
        }

        // Partial usage updates (cumulative snapshots — not persisted)
        if (block.type === 'Usage') {
          if (block.content && block.content.usage) {
            let agentID     = (params.agent && params.agent.id) || null;
            let serviceType = (params.agentPlugin && params.agentPlugin.constructor.serviceType) || 'unknown';

            this.emit('interaction:usage', {
              sessionID, interactionID, agentID, serviceType,
              usage:   block.content.usage,
              isFinal: false,
            });
          }
          continue;
        }

        // Assign metadata to the block
        let frameID   = generateID('frm_');
        let timestamp = Date.now();

        if (block.type === 'Message') {
          let html = block.content && block.content.html;

          // Hook: agent → user
          if (hookRunner) {
            let hookResult = await hookRunner.run('prepareMessage', {
              source: 'agent', target: 'user', message: html,
              context: { sessionID, interactionID },
            });
            if (hookResult.action === 'block') continue;
            html = hookResult.message;
          }

          if (html && sanitizer)
            html = sanitizer.sanitize(html);

          await this._createFrame(sessionID, {
            id: frameID, type: 'Message', content: { html }, timestamp, interactionID,
            authorType: block.authorType || 'agent', authorID: block.authorID || null,
            parentID: params.parentID || null,
            hidden: false, deleted: false, processed: false,
          }, frameManager, { authorType: block.authorType || 'agent', authorID: block.authorID || null }, signingContext);
        } else if (block.type === 'ToolCall') {
          // Hook: agent → tool
          if (hookRunner) {
            let hookResult = await hookRunner.run('prepareMessage', {
              source: 'agent', target: 'tool', message: block.content,
              context: { sessionID, interactionID, toolName: block.content.toolName },
            });
            if (hookResult.action === 'block') {
              result = { type: 'ToolResult', content: { output: `Blocked: ${hookResult.reason || 'hook blocked tool execution'}`, _sessionID: sessionID } };
              continue;
            }
          }

          // Execute tool (permission checking handled inside tool.execute())
          await this._createFrame(sessionID, {
            id: frameID, type: 'ToolCall',
            content: { toolName: block.content.toolName, arguments: block.content.arguments, toolUseID: block.content.toolUseId || block.content.toolUseID },
            timestamp, interactionID,
            authorType: block.authorType || 'agent', authorID: block.authorID || null,
            parentID: params.parentID || null,
            hidden: false, deleted: false, processed: false,
          }, frameManager, { authorType: block.authorType || 'agent', authorID: block.authorID || null }, signingContext);

          let executeTool = params.executeTool;
          let toolOutput  = '';

          if (typeof executeTool === 'function') {
            try {
              toolOutput = await executeTool(block.content.toolName, block.content.arguments);
            } catch (toolError) {
              // PermissionRequiredError from tool's internal permission check
              // -> permission required: feed tool_result back to agent
              // For child sessions (no user), fall back to hardBreak for routing
              if (toolError.name === 'PermissionRequiredError') {
                let permissionContext = {
                  title:       toolError.title,
                  titleParams: toolError.titleParams,
                  description: toolError.description,
                  details:     toolError.details,
                };

                // Check if this session has a user (can show permission dialog directly)
                // If not, use hardBreak to route to the nearest user ancestor
                let sessionManager = (typeof this._getSessionManager === 'function') ? this._getSessionManager() : null;
                let needsRouting   = false;

                if (sessionManager) {
                  let nearestUserSessionID = await sessionManager.getNearestUserAncestor(sessionID);
                  needsRouting = (nearestUserSessionID && nearestUserSessionID !== sessionID) || !nearestUserSessionID;
                }

                if (needsRouting) {
                  // Child session — route permission to parent via hardBreak
                  await this._permissionHandler.hardBreak(
                    sessionID, generator, block, interactionID, params, frameManager, permissionContext,
                  );
                  return;
                }

                // Normal session with user — create permission-request frame inline
                // and feed a tool_result back to keep the conversation valid

                // --- Dedup hash: prevent duplicate permission requests for the same tool call ---
                let requestHashInput = JSON.stringify({
                  toolName:  block.content.toolName,
                  arguments: block.content.arguments || {},
                  agentID:   (params.agent && params.agent.id) || null,
                  sessionID,
                });
                let requestHash = createHash('sha256').update(requestHashInput).digest('hex').slice(0, 32);

                // Check for existing unprocessed PermissionRequest with same hash
                let models         = this._context.getProperty('models');
                let dedupMatch     = null;

                if (models && models.Frame) {
                  let existingRequests = await models.Frame.where
                    .sessionID.EQ(sessionID)
                    .AND.type.EQ('PermissionRequest')
                    .AND.processed.EQ(false)
                    .all();

                  // Only dedup within a short time window (30s) — repeated identical
                  // commands (e.g., monitoring ls /tmp/) should get fresh requests
                  let dedupWindowMs = 30000;
                  let now           = Date.now();

                  dedupMatch = existingRequests.find((f) => {
                    let existingContent = (typeof f.content === 'string') ? (() => { try { return JSON.parse(f.content); } catch (_e) { return {}; } })() : (f.content || {});
                    if (!existingContent || existingContent.requestHash !== requestHash)
                      return false;

                    // Check time window
                    let createdAt = f.timestamp || f.createdAt || 0;
                    return (now - createdAt) < dedupWindowMs;
                  }) || null;
                }

                if (dedupMatch) {
                  // Duplicate — return existing request ID without creating a new frame
                  toolOutput = `Permission already requested. Request ID: ${dedupMatch.id}. Awaiting user approval.`;
                  await this._createFrame(sessionID, {
                    id: generateID('frm_'), type: 'ToolResult',
                    content: { output: toolOutput, toolUseID: block.content.toolUseId || block.content.toolUseID, _sessionID: sessionID },
                    timestamp: Date.now(), interactionID,
                    authorType: 'system', authorID: null,
                    parentID: params.parentID || null,
                    hidden: false, deleted: false, processed: false,
                  }, frameManager, { authorType: 'system' }, signingContext);

                  result = { type: 'ToolResult', content: { output: toolOutput, _sessionID: sessionID } };
                  continue;
                }

                // No duplicate — create new permission request
                let requestFrameID = generateID('frm_');
                // Parse shell commands for the permission UI (command + arguments table)
                let toolArgs       = block.content.arguments || {};
                let parsedCommands = toolArgs._parsedCommands || null;

                if (!parsedCommands && block.content.toolName === 'shell:execute' && toolArgs.command)
                  parsedCommands = parseShellCommands(toolArgs.command);

                let requestContent = {
                  toolName:          block.content.toolName,
                  arguments:         block.content.arguments,
                  permissionContext,
                  requestHash,
                };

                if (parsedCommands && parsedCommands.length > 0)
                  requestContent.parsedCommands = parsedCommands;

                await this._createFrame(sessionID, {
                  id:            requestFrameID,
                  type:          'PermissionRequest',
                  content:       requestContent,
                  state:         JSON.stringify({
                    toolName:      block.content.toolName,
                    toolArguments: block.content.arguments,
                    toolUseID:     block.content.toolUseId || block.content.toolUseID,
                    sessionID:     sessionID,
                    agentID:       (params.agent && params.agent.id) || null,
                    interactionID: interactionID,
                    step:          'awaiting-approval',
                  }),
                  timestamp:     Date.now(),
                  interactionID,
                  authorType:    'system',
                  authorID:      null,
                  parentID:      params.parentID || null,
                  hidden:        false,
                  deleted:       false,
                  processed:     false,
                }, frameManager, { authorType: 'system' }, signingContext);

                this.emit('permission:request', { sessionID, frameID: requestFrameID, toolName: block.content.toolName });

                // Feed result back to agent — conversation stays valid
                toolOutput = `PERMISSION REQUIRED for "${block.content.toolName}". A permission request (ID: ${requestFrameID}) has been sent to the user. Do NOT retry this tool call — wait for the user to approve or deny.`;
                await this._createFrame(sessionID, {
                  id: generateID('frm_'), type: 'ToolResult',
                  content: { output: toolOutput, toolUseID: block.content.toolUseId || block.content.toolUseID, _sessionID: sessionID },
                  timestamp: Date.now(), interactionID,
                  authorType: 'system', authorID: null,
                  parentID: params.parentID || null,
                  hidden: false, deleted: false, processed: false,
                }, frameManager, { authorType: 'system' }, signingContext);

                result = { type: 'ToolResult', content: { output: toolOutput, _sessionID: sessionID } };
                continue;
              }

              // PermissionDeniedError from Permissions.evaluate() deny rules
              // -> create permission-denied frame and feed error back to agent
              if (toolError.name === 'PermissionDeniedError') {
                await this._createFrame(sessionID, {
                  id: generateID('frm_'), type: 'PermissionDenied',
                  content: { toolName: block.content.toolName, reason: toolError.reason },
                  timestamp: Date.now(), interactionID,
                  authorType: 'system', authorID: null,
                  parentID: params.parentID || null,
                  hidden: false, deleted: false, processed: false,
                }, frameManager, { authorType: 'system' }, signingContext);
                result = { type: 'ToolResult', content: { output: `Error: ${toolError.message}`, _sessionID: sessionID } };
                continue;
              }

              toolOutput = `Error executing tool: ${toolError.message}`;
              await this._createFrame(sessionID, {
                id: generateID('frm_'), type: 'ToolError',
                content: { toolName: block.content.toolName, message: toolError.message },
                timestamp: Date.now(), interactionID,
                authorType: 'system', authorID: null,
                parentID: params.parentID || null,
                hidden: false, deleted: false, processed: false,
              }, frameManager, { authorType: 'system' }, signingContext);
            }
          }

          // Hook: tool → agent
          if (hookRunner) {
            let hookResult = await hookRunner.run('prepareMessage', {
              source: 'tool', target: 'agent', message: toolOutput,
              context: { sessionID, interactionID, toolName: block.content.toolName },
            });
            toolOutput = hookResult.message;
          }

          // Render hint → visible tool-activity frame (before stripping)
          if (toolOutput && typeof toolOutput === 'object' && toolOutput._renderHint) {
            let hint = toolOutput._renderHint;

            await this._createFrame(sessionID, {
              id:            generateID('frm_'),
              type:          'ToolActivity',
              content:       { toolName: block.content.toolName, renderType: hint.renderType, renderData: hint.renderData },
              timestamp:     Date.now(),
              interactionID,
              authorType:    'system',
              authorID:      null,
              parentID:      params.parentID || null,
              hidden:        false,
              deleted:       false,
              processed:     false,
            }, frameManager, { authorType: 'system' }, signingContext);

            // Strip _renderHint before passing to agent
            let { _renderHint, ...cleanOutput } = toolOutput;
            toolOutput = cleanOutput;
          }

          // =============================================================================
          // TOOL LOG INTERCEPTION — tool-log plan (tool-log.yaml)
          // Stores ALL tool outputs in ValueStore. If output > 1024 Unicode chars,
          // replace toolOutput with a JSON pointer message.
          // Best-effort: failures do NOT block tool delivery.
          // =============================================================================
          // NOTE FOR COMPACTION BOT: Compaction trigger check should be added AFTER
          // the tool-result frame is created (after the _createFrame call below), not here.
          // =============================================================================
          toolOutput = await this._storeAndMaybeReplaceToolOutput(
            sessionID, interactionID, block, params, toolOutput, signingContext,
          );

          await this._createFrame(sessionID, {
            id: generateID('frm_'), type: 'ToolResult',
            content: { output: toolOutput, toolUseID: block.content.toolUseId || block.content.toolUseID, _sessionID: sessionID },
            timestamp: Date.now(), interactionID,
            authorType: 'system', authorID: null,
            parentID: params.parentID || null,
            hidden: false, deleted: false, processed: false,
          }, frameManager, { authorType: 'system' }, signingContext);

          result = { type: 'ToolResult', content: { output: toolOutput, _sessionID: sessionID } };
        } else if (block.type === 'Reflection') {
          await this._createFrame(sessionID, {
            id: frameID, type: 'Reflection', content: block.content, timestamp, interactionID,
            authorType: block.authorType || 'agent', authorID: block.authorID || null,
            parentID: params.parentID || null,
            hidden: true, deleted: false, processed: false,
          }, frameManager, { authorType: block.authorType || 'agent', authorID: block.authorID || null }, signingContext);
        }
      }
    } catch (error) {
      console.error(`[InteractionLoop] Error in interaction ${interactionID} (session ${sessionID}):`, error);

      // Build a user-friendly error message instead of dumping raw API errors
      let errorMessage = error.message || 'An unexpected error occurred.';

      // Detect common API errors and provide helpful messages
      if (errorMessage.includes('tool_use') && errorMessage.includes('tool_result'))
        errorMessage = 'The conversation history has inconsistent tool state. This is a known issue being fixed. Please try sending your message again.';
      else if (errorMessage.includes('invalid_request_error'))
        errorMessage = 'The AI service rejected the request. Please try again or start a new session.';
      else if (errorMessage.includes('rate_limit') || errorMessage.includes('429'))
        errorMessage = 'Rate limited — please wait a moment and try again.';
      else if (errorMessage.includes('overloaded') || errorMessage.includes('529'))
        errorMessage = 'The AI service is temporarily overloaded. Please try again in a few moments.';

      await this._createFrame(sessionID, {
        id: generateID('frm_'), type: 'Error', content: { message: errorMessage },
        timestamp: Date.now(), interactionID,
        authorType: 'system', authorID: null,
        parentID: params.parentID || null,
        hidden: false, deleted: false, processed: false,
      }, frameManager, { authorType: 'system' }, signingContext);
    } finally {
      let agentID   = params.agent && params.agent.id;
      let activeKey = this._activeKey(sessionID, agentID);

      if (agentID)
        this._advanceAgentRef(frameManager, agentID);

      // If cancelInteraction already removed the key, skip cleanup to avoid
      // double-emit of interaction:end and unwanted queue drain.
      let wasActive = this._active.has(activeKey);
      this._active.delete(activeKey);

      if (wasActive) {
        this.emit('interaction:end', { sessionID, interactionID, agentID: agentID || null });
        await this._drainQueue(sessionID, params, agentID);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // _persistTokenUsage — write a Token row for cost tracking
  // ---------------------------------------------------------------------------

  async _persistTokenUsage(sessionID, interactionID, params, usage) {
    try {
      let models = this._context.getProperty('models');
      if (!models || !models.Token)
        return;

      let agent          = params.agent;
      let organizationID = (agent && agent.organizationID) || null;
      let agentID        = (agent && agent.id) || null;
      let serviceType    = (params.agentPlugin && params.agentPlugin.constructor.serviceType) || 'unknown';

      if (!organizationID)
        return;

      await models.Token.create({
        organizationID,
        sessionID,
        agentID,
        interactionID,
        serviceType,
        inputTokens:              usage.inputTokens || 0,
        outputTokens:             usage.outputTokens || 0,
        cacheReadInputTokens:     usage.cacheReadInputTokens || 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
      });
    } catch (error) {
      // Non-fatal — don't break the interaction if token persistence fails
      console.error('[InteractionLoop] Failed to persist token usage:', error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // cancelInteraction
  // ---------------------------------------------------------------------------

  async cancelInteraction(sessionID, options = {}) {
    let targetAgentID = options.targetAgentID || null;
    let authorType    = options.authorType || 'system';
    let authorID      = options.authorID || null;
    let activeKey     = this._activeKey(sessionID, targetAgentID);
    let active        = this._active.get(activeKey);

    if (!active)
      return null;

    // Delete active key FIRST so isActive() returns false immediately
    this._active.delete(activeKey);

    // Signal the generator to stop. Non-blocking — the generator may be
    // awaiting an internal promise (e.g., API call) and will finalize when
    // that settles. We don't await here to avoid hanging on stuck generators.
    active.generator.return().catch(() => {});

    let frameManager   = active.frameManager || null;
    let signingContext = (active.params && active.params._signingContext) || null;
    await this._createFrame(sessionID, {
      id: generateID('frm_'), type: 'Stop',
      content: { targetAgentID }, authorType, authorID,
    }, frameManager, { authorType, authorID: authorID }, signingContext);

    this.emit('interaction:end', { sessionID, interactionID: active.interactionID, agentID: targetAgentID });

    let queueKey = this._activeKey(sessionID, targetAgentID);
    let queued   = this._queues.get(queueKey) || [];
    this._queues.delete(queueKey);

    return queued.length > 0 ? queued.join('\n\n') : null;
  }

  // ---------------------------------------------------------------------------
  // Message Queue
  // ---------------------------------------------------------------------------

  queueMessage(sessionID, text, agentID) {
    let queueKey = this._activeKey(sessionID, agentID);

    if (!this._queues.has(queueKey))
      this._queues.set(queueKey, []);

    this._queues.get(queueKey).push(text);
  }

  async _drainQueue(sessionID, params, agentID) {
    let queueKey = this._activeKey(sessionID, agentID);
    let queue    = this._queues.get(queueKey);

    if (!queue || queue.length === 0)
      return;

    let combinedMessage = queue.join('\n\n');
    this._queues.delete(queueKey);

    await this.startInteraction(sessionID, {
      ...params,
      userMessage:          combinedMessage,
      replayFromPermission: false,
    });
  }

  // ---------------------------------------------------------------------------
  // postMessage — persist a user message without starting an agent interaction
  // ---------------------------------------------------------------------------
  // Used when a user sends a message in a session with no agent, or when
  // simply recording a message without triggering AI. The frame is persisted
  // and broadcast via SSE so all connected clients see it.
  // ---------------------------------------------------------------------------

  async postMessage(sessionID, { text, authorType, authorID, parentID, convertMarkdown, userPrivateKey, userPublicKey }) {
    if (!sessionID)
      throw new Error('sessionID is required');

    if (!text)
      throw new Error('text is required');

    // Check for slash commands before persisting as a plain message
    let commandMatch = this._commandHandler.parse(text);
    if (commandMatch) {
      let interactionID = await this._commandHandler.execute(sessionID, {
        userMessage: text,
        authorType:  authorType || 'user',
        authorID:    authorID || null,
      }, commandMatch);

      return { interactionID, frameID: null };
    }

    let framePersistence = this._getFramePersistence();
    let sessionManager   = this._getSessionManager();

    // Load FrameManager for commit-based broadcasting
    let frameManager = sessionManager.getFrameManager(sessionID);
    await framePersistence.loadFramesInto(frameManager, sessionID);

    // Sync order counter with DB max to avoid order collisions
    let nextDbOrder = await framePersistence.getNextOrder(sessionID);
    frameManager.syncOrderCounter(nextDbOrder - 1);

    let frameID       = generateID('frm_');
    let interactionID = generateID('int_');

    // Optionally convert markdown → sanitized HTML
    let frameContent;

    if (convertMarkdown) {
      let converter = this._getMarkdownConverter();
      let html      = (converter) ? converter.convert(text) : text;
      frameContent  = { html };
    } else {
      frameContent = { text };
    }

    let signingContext = (userPrivateKey) ? { userPrivateKey, userPublicKey: userPublicKey || null } : null;

    await this._createFrame(sessionID, {
      id:            frameID,
      type:          'UserMessage',
      content:       frameContent,
      timestamp:     Date.now(),
      interactionID,
      authorType:    authorType || 'user',
      authorID:      authorID || null,
      parentID:      parentID || null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    }, frameManager, { authorType: authorType || 'user', authorID: authorID || null }, signingContext);

    return { interactionID, frameID };
  }

  // ---------------------------------------------------------------------------
  // State Queries
  // ---------------------------------------------------------------------------

  isActive(sessionID, agentID) {
    if (agentID)
      return this._active.has(this._activeKey(sessionID, agentID));

    // Session-level: true if any agent (or agent-less) is active
    if (this._active.has(sessionID))
      return true;

    let prefix = `${sessionID}:`;
    for (let key of this._active.keys()) {
      if (key.startsWith(prefix))
        return true;
    }

    return false;
  }

  getQueuedMessages(sessionID, agentID) {
    let queueKey = this._activeKey(sessionID, agentID);
    return this._queues.get(queueKey) || [];
  }

  requestPrimerRefresh(sessionID) {
    this._primerNeeded.add(sessionID);
  }

  // ---------------------------------------------------------------------------
  // Per-agent ref management
  // ---------------------------------------------------------------------------

  _ensureAgentRef(frameManager, agentID) {
    let refName  = `processed/agent-${agentID}`;
    let existing = frameManager.getRef(refName);
    if (existing !== undefined) return;

    let headsMain = frameManager.getRef('heads/main');
    if (headsMain !== undefined) {
      frameManager.createRef(refName, headsMain);
    } else {
      let latest = frameManager.getLatestCommit();
      if (latest)
        frameManager.createRef(refName, latest.order);
    }
  }

  _advanceAgentRef(frameManager, agentID) {
    let refName   = `processed/agent-${agentID}`;
    let headsMain = frameManager.getRef('heads/main');
    if (headsMain === undefined) return;

    let existing = frameManager.getRef(refName);
    if (existing === undefined)
      frameManager.createRef(refName, headsMain);
    else if (existing !== headsMain)
      frameManager.updateRef(refName, headsMain);
  }

  // ---------------------------------------------------------------------------
  // Delegation wrappers — keep backward compat for tests/external callers
  // ---------------------------------------------------------------------------

  _parseCommand(message) {
    return this._commandHandler.parse(message);
  }

  _resolveCommand(commandName) {
    return this._commandHandler.resolve(commandName);
  }

  _isFirstMessage(frames) {
    return isFirstMessage(frames);
  }

  _injectPrimer(messages, primer) {
    return injectPrimer(messages, primer);
  }

  _buildMessages(frames, forAgentID, options) {
    return buildMessages(frames, forAgentID, options);
  }

  // ---------------------------------------------------------------------------
  // --- Compaction: startup cleanup delegation ---
  // ---------------------------------------------------------------------------
  // Delegates to CompactionRunner.cleanupStaleCompactions() to mark any
  // compaction frames stuck in 'started' status as 'abandoned'.
  // Called from server startup flow for each session's FrameManager.
  // ---------------------------------------------------------------------------

  async cleanupStaleCompactions(frameManager) {
    return this._compactionRunner.cleanupStaleCompactions(frameManager);
  }
}
