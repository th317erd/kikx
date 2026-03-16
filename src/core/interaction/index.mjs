'use strict';

import { EventEmitter }          from 'node:events';
import XID                       from 'xid-js';
import { PermissionDeniedError } from '../permissions/permission-denied-error.mjs';
import { PermissionHandler }     from './permission-handler.mjs';
import { CommandHandler }        from './command-handler.mjs';
import { isFirstMessage, injectPrimer, buildMessages } from './message-history.mjs';
import { truncateContent, truncateConversation }       from './context-truncation.mjs';
import { reinjectAbilities }                           from './abilities-reinjection.mjs';
import { signFrameContent, decryptAgentPrivateKey }    from '../crypto/frame-signing.mjs';

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

    // Permission waiting: compositeKey -> { frameID, params }
    this._permissionWaiting = new Map();

    // Sessions needing primer on next interaction (set by /reload command)
    this._primerNeeded = new Set();

    // Delegated subsystems
    this._permissionHandler = new PermissionHandler(this);
    this._commandHandler    = new CommandHandler(this);
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
  // Returns the hex signature, or null if signing is not possible.
  // ---------------------------------------------------------------------------

  _signFrame(frameData, signingContext) {
    let keystore = this._getKeystore();
    if (!keystore)
      return null;

    let authorType = frameData.authorType;
    let content    = frameData.content;

    if (authorType === 'system')
      return signFrameContent(keystore, content, 'system', null);

    if (authorType === 'agent' && signingContext && signingContext.agentPrivateKey)
      return signFrameContent(keystore, content, 'agent', signingContext.agentPrivateKey);

    if (authorType === 'user' && signingContext && signingContext.userPrivateKey)
      return signFrameContent(keystore, content, 'user', signingContext.userPrivateKey);

    return null;
  }

  // ---------------------------------------------------------------------------
  // _buildSigningContext — prepare cached signing keys for an interaction
  // ---------------------------------------------------------------------------
  // Called once per startInteraction(). Decrypts the agent private key (if
  // available) so it can be reused for every frame in the interaction without
  // repeated SMK-derived decryption.
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

    // User private key: passed in by caller (e.g., server decrypted via UMK)
    if (params.userPrivateKey)
      context.userPrivateKey = params.userPrivateKey;

    return context;
  }

  // ---------------------------------------------------------------------------
  // _createFrame — routes frame creation through FrameManager for commits
  // ---------------------------------------------------------------------------

  async _createFrame(sessionID, frameData, frameManager, mergeOptions = {}, signingContext) {
    // Sign the frame content before commit (best-effort)
    if (!frameData.signature) {
      let signature = this._signFrame(frameData, signingContext);
      if (signature)
        frameData.signature = signature;
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

    // Clean up stale permission-waiting state for this session/agent.
    // If the user sends a new message while a permission is pending, the old
    // permission becomes orphaned. Clear it so the agent context stays clean.
    if (!params.replayFromPermission && this._permissionWaiting.has(activeKey)) {
      this._permissionWaiting.delete(activeKey);
    } else if (!params.replayFromPermission) {
      // Also check for composite key matches (session prefix scan)
      let prefix = `${sessionID}:`;
      for (let key of this._permissionWaiting.keys()) {
        if (key === sessionID || key.startsWith(prefix)) {
          this._permissionWaiting.delete(key);
          break;
        }
      }
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
          type:          'hook-blocked',
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
      let agentCount      = params.agentCount || 1;
      let estimatedTokens = Math.ceil(params.userMessage.length / 4) * agentCount;

      // Optionally convert markdown → sanitized HTML
      let frameContent;

      if (params.convertMarkdown) {
        let converter = this._getMarkdownConverter();
        let html      = (converter) ? converter.convert(params.userMessage) : params.userMessage;
        frameContent  = { html, estimatedTokens };
      } else {
        frameContent = { text: params.userMessage, estimatedTokens };
      }

      await this._createFrame(sessionID, {
        id:            generateID('frm_'),
        type:          'user-message',
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
    let messages   = buildMessages(allFrames, forAgentID);
    messages       = truncateContent(messages);
    messages       = truncateConversation(messages);

    // Inject primer for first message, explicit request, or new agent
    let primerRequested = this._primerNeeded.delete(sessionID);
    let agentRefExists  = forAgentID && frameManager.getRef(`processed/agent-${forAgentID}`) !== undefined;
    let needsPrimer     = params.injectPrimer || isFirstMessage(allFrames) || primerRequested || (forAgentID && !agentRefExists);

    if (needsPrimer) {
      let primerAssembler = this._context.getProperty('primerAssembler');
      if (primerAssembler) {
        let primer = await primerAssembler.assemble(params.agent, { sessionID });
        if (primer)
          messages = injectPrimer(messages, primer);
      }
    }

    // Re-inject abilities after truncation if primer was not injected this turn
    messages = await reinjectAbilities(messages, params.agent, {
      primerInjected: needsPrimer,
      isDMForAgent:   () => this._isDMForAgent(params.agent, sessionID),
    });

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
    await this._iterateGenerator(sessionID, generator, interactionID, params, frameManager);

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

        if (block.type === 'done') {
          if (block.content && block.content.usage) {
            this.emit('interaction:usage', {
              sessionID, interactionID,
              usage: block.content.usage,
            });
          }

          break;
        }

        // Transient streaming events — not persisted, just forwarded
        if (block.type === 'delta') {
          this.emit('delta', {
            sessionID, interactionID,
            content: block.content, authorType: block.authorType, authorID: block.authorID,
          });
          continue;
        }

        if (block.type === 'reflection-delta') {
          this.emit('reflection-delta', {
            sessionID, interactionID,
            content: block.content, authorType: block.authorType, authorID: block.authorID,
          });
          continue;
        }

        // Partial usage updates
        if (block.type === 'usage') {
          if (block.content && block.content.usage)
            this.emit('interaction:usage', { sessionID, interactionID, usage: block.content.usage });
          continue;
        }

        // Assign metadata to the block
        let frameID   = generateID('frm_');
        let timestamp = Date.now();

        if (block.type === 'message') {
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
            id: frameID, type: 'message', content: { html }, timestamp, interactionID,
            authorType: block.authorType || 'agent', authorID: block.authorID || null,
            parentID: params.parentID || null,
            hidden: false, deleted: false, processed: false,
          }, frameManager, { authorType: block.authorType || 'agent', authorID: block.authorID || null }, signingContext);
        } else if (block.type === 'tool-call') {
          // Hook: agent → tool
          if (hookRunner) {
            let hookResult = await hookRunner.run('prepareMessage', {
              source: 'agent', target: 'tool', message: block.content,
              context: { sessionID, interactionID, toolName: block.content.toolName },
            });
            if (hookResult.action === 'block') {
              result = { type: 'tool-result', content: { output: `Blocked: ${hookResult.reason || 'hook blocked tool execution'}` } };
              continue;
            }
          }

          // Check permission
          let checkPermission = params.checkPermission;
          let needsPermission = false;

          if (typeof checkPermission === 'function') {
            try {
              needsPermission = await checkPermission(block.content.toolName, block.content.arguments);
            } catch (permError) {
              if (permError.name === 'PermissionDeniedError') {
                await this._createFrame(sessionID, {
                  id: generateID('frm_'), type: 'permission-denied',
                  content: { toolName: block.content.toolName, reason: permError.reason },
                  timestamp: Date.now(), interactionID,
                  authorType: 'system', authorID: null,
                  parentID: params.parentID || null,
                  hidden: false, deleted: false, processed: false,
                }, frameManager, { authorType: 'system' }, signingContext);
                result = { type: 'tool-result', content: { output: `Error: ${permError.message}` } };
                continue;
              }
              throw permError;
            }
          }

          if (needsPermission) {
            await this._permissionHandler.hardBreak(sessionID, generator, block, interactionID, params, frameManager);
            return;
          }

          // Execute tool
          await this._createFrame(sessionID, {
            id: frameID, type: 'tool-call',
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
              toolOutput = `Error executing tool: ${toolError.message}`;
              await this._createFrame(sessionID, {
                id: generateID('frm_'), type: 'tool-error',
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

          await this._createFrame(sessionID, {
            id: generateID('frm_'), type: 'tool-result',
            content: { output: toolOutput, toolUseID: block.content.toolUseId || block.content.toolUseID },
            timestamp: Date.now(), interactionID,
            authorType: 'system', authorID: null,
            parentID: params.parentID || null,
            hidden: false, deleted: false, processed: false,
          }, frameManager, { authorType: 'system' }, signingContext);

          result = { type: 'tool-result', content: { output: toolOutput } };
        } else if (block.type === 'reflection') {
          await this._createFrame(sessionID, {
            id: frameID, type: 'reflection', content: block.content, timestamp, interactionID,
            authorType: block.authorType || 'agent', authorID: block.authorID || null,
            parentID: params.parentID || null,
            hidden: true, deleted: false, processed: false,
          }, frameManager, { authorType: block.authorType || 'agent', authorID: block.authorID || null }, signingContext);
        }
      }
    } catch (error) {
      console.error(`[InteractionLoop] Error in interaction ${interactionID} (session ${sessionID}):`, error);

      await this._createFrame(sessionID, {
        id: generateID('frm_'), type: 'error', content: { message: error.message },
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
      id: generateID('frm_'), type: 'stop',
      content: { targetAgentID }, authorType, authorID,
    }, frameManager, { authorType, authorID: authorID }, signingContext);

    this.emit('interaction:end', { sessionID, interactionID: active.interactionID, agentID: targetAgentID });

    let queueKey = this._activeKey(sessionID, targetAgentID);
    let queued   = this._queues.get(queueKey) || [];
    this._queues.delete(queueKey);

    return queued.length > 0 ? queued.join('\n\n') : null;
  }

  // ---------------------------------------------------------------------------
  // Permission Delegation
  // ---------------------------------------------------------------------------

  async approvePermission(sessionID, frameID) {
    return this._permissionHandler.approve(sessionID, frameID);
  }

  async denyPermission(sessionID, frameID) {
    return this._permissionHandler.deny(sessionID, frameID);
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

  async postMessage(sessionID, { text, authorType, authorID, parentID, convertMarkdown, userPrivateKey }) {
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
      frameContent  = { html, estimatedTokens: Math.ceil(text.length / 4) };
    } else {
      frameContent = { text, estimatedTokens: Math.ceil(text.length / 4) };
    }

    let signingContext = (userPrivateKey) ? { userPrivateKey } : null;

    await this._createFrame(sessionID, {
      id:            frameID,
      type:          'user-message',
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

  isWaitingForPermission(sessionID, agentID) {
    if (agentID)
      return this._permissionWaiting.has(this._activeKey(sessionID, agentID));

    // Session-level: true if any agent is waiting
    if (this._permissionWaiting.has(sessionID))
      return true;

    let prefix = `${sessionID}:`;
    for (let key of this._permissionWaiting.keys()) {
      if (key.startsWith(prefix))
        return true;
    }

    return false;
  }

  getPermissionWaiting(sessionID) {
    return this._permissionHandler._findWaiting(sessionID);
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

  _buildMessages(frames, forAgentID) {
    return buildMessages(frames, forAgentID);
  }
}
