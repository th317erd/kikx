'use strict';

import { EventEmitter } from 'node:events';

// =============================================================================
// Session Scheduler
// =============================================================================
// The brain of multi-agent. Watches commits on a FrameManager, checks agent
// refs, and triggers interactions for agents with unprocessed frames.
//
// Safety: Does NOT trigger an agent on commits it authored (prevents infinite
// loops). Does NOT trigger an agent while it's already active.
//
// Events:
//   'schedule'     — { sessionID, agentID, newFrames } — agent needs to run
//   'schedule:skip' — { sessionID, agentID, reason }    — agent skipped
// =============================================================================

export class SessionScheduler extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {import('../session/index.mjs').SessionManager} options.sessionManager
   * @param {object} options.interactionLoop
   */
  constructor(options = {}) {
    super();

    /** @type {import('../session/index.mjs').SessionManager} */
    this._sessionManager  = options.sessionManager;
    /** @type {object} */
    this._interactionLoop = options.interactionLoop;

    if (!this._sessionManager)
      throw new Error('SessionScheduler requires sessionManager');

    if (!this._interactionLoop)
      throw new Error('SessionScheduler requires interactionLoop');

    /** @type {Map<string, boolean>} agentID → true while agent is running */
    this._activeAgents = new Map();

    /** @type {Map<string, import('../types').ResolveContext>} sessionID → resolve context */
    this._resolveContexts = new Map();

    /** @type {Map<string, Array<{ agentID: string }>>} sessionID → queued triggers */
    this._pendingTriggers = new Map();

    /** @type {AgentResolver|null} */
    this._agentResolver = null;
    /** @type {Function|null} */
    this._onInteractionEnd = null;
    /** @type {Function|null} */
    this._onScheduleCancel = null;
  }

  // ---------------------------------------------------------------------------
  // Resolve Context — stores decryption context for secondary agents
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @param {import('../types').ResolveContext} context
   * @returns {void}
   */
  setResolveContext(sessionID, context) {
    this._resolveContexts.set(sessionID, context);
  }

  /**
   * @param {string} sessionID
   * @returns {import('../types').ResolveContext|null}
   */
  getResolveContext(sessionID) {
    return this._resolveContexts.get(sessionID) || null;
  }

  /**
   * @param {string} sessionID
   * @returns {void}
   */
  clearResolveContext(sessionID) {
    this._resolveContexts.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // onCommit
  // ---------------------------------------------------------------------------
  /**
   * Called after a commit is created on a session's FrameManager.
   * Determines which agents need to be triggered.
   *
   * @param {string} sessionID
   * @param {import('../types').Commit} commit
   * @returns {Promise<Array<{ agentID: string, newFrames: import('../types').FrameData[] }>>}
   */
  async onCommit(sessionID, commit) {
    if (!sessionID || !commit)
      return [];

    // Check if the commit contains a stop frame — handle cancellation
    // commit.changes are { frameID, operation } records; resolve to actual frames
    let frameManager = this._sessionManager.getFrameManager(sessionID);
    let stopFrames   = [];

    for (let change of (commit.changes || [])) {
      let frame = frameManager.getHead(change.frameID);
      if (frame && frame.type === 'Stop')
        stopFrames.push(frame);
    }

    if (stopFrames.length > 0) {
      await this._handleStopFrames(sessionID, stopFrames);
      return [];
    }

    let participants = await this._sessionManager.getParticipants(sessionID);
    if (!participants || participants.length === 0)
      return [];

    let headsMain = frameManager.getRef('heads/main');

    if (headsMain === undefined)
      return [];

    let scheduled = [];

    for (let participant of participants) {
      let agentID = participant.agentID;

      if (!agentID)
        continue;

      // Skip if this agent authored the commit (prevents infinite loop)
      if (commit.authorID && commit.authorID === agentID) {
        this.emit('schedule:skip', { sessionID, agentID, reason: 'self-authored' });
        continue;
      }

      // Skip if agent is already active
      let activeKey = `${sessionID}:${agentID}`;
      if (this._activeAgents.get(activeKey)) {
        this.emit('schedule:skip', { sessionID, agentID, reason: 'already-active' });
        continue;
      }

      // Check if agent has unprocessed frames
      let refName   = `processed/agent-${agentID}`;
      let agentRef  = frameManager.getRef(refName);

      // If no ref exists, agent has never processed — all frames are new
      let newFrames;

      if (agentRef === undefined) {
        newFrames = frameManager.diff(0, headsMain);
      } else if (agentRef === headsMain) {
        // Agent is already caught up
        this.emit('schedule:skip', { sessionID, agentID, reason: 'already-caught-up' });
        continue;
      } else {
        newFrames = frameManager.diff(agentRef, headsMain);
      }

      if (!newFrames || newFrames.length === 0) {
        this.emit('schedule:skip', { sessionID, agentID, reason: 'no-new-frames' });
        continue;
      }

      // Mark agent as active
      this._activeAgents.set(activeKey, true);

      scheduled.push({ agentID, newFrames });

      this.emit('schedule', { sessionID, agentID, newFrames });
    }

    return scheduled;
  }

  // ---------------------------------------------------------------------------
  // _handleStopFrames
  // ---------------------------------------------------------------------------
  /**
   * Processes stop frames from a commit. If targetAgentID is set, cancels that
   * specific agent. If null, cancels ALL active agents in the session.
   * @param {string} sessionID
   * @param {import('../types').FrameData[]} stopFrames
   * @returns {Promise<void>}
   */
  async _handleStopFrames(sessionID, stopFrames) {
    for (let frame of stopFrames) {
      let targetAgentID = frame.content && frame.content.targetAgentID;

      if (targetAgentID) {
        // Cancel a specific agent
        await this._cancelAgent(sessionID, targetAgentID);
      } else {
        // Cancel all active agents in this session
        let activeAgents = this.getActiveAgents(sessionID);
        for (let agentID of activeAgents)
          await this._cancelAgent(sessionID, agentID);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // _cancelAgent
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {Promise<void>}
   */
  async _cancelAgent(sessionID, agentID) {
    let activeKey = `${sessionID}:${agentID}`;

    if (!this._activeAgents.get(activeKey))
      return;

    this._activeAgents.delete(activeKey);
    this.emit('schedule:cancel', { sessionID, agentID });
  }

  // ---------------------------------------------------------------------------
  // markComplete / markIdle
  // ---------------------------------------------------------------------------

  /**
   * Called when an agent's interaction completes. Clears the active flag.
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {void}
   */
  markComplete(sessionID, agentID) {
    let activeKey = `${sessionID}:${agentID}`;
    this._activeAgents.delete(activeKey);

    // Don't clear resolve context here — _onInteractionEnd calls _triggerNext
    // after markComplete, and _triggerNext needs the resolveContext to decrypt
    // API keys for secondary agents. Context is cleared in _triggerNext when
    // no more pending triggers remain.
  }

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {void}
   */
  markActive(sessionID, agentID) {
    this._activeAgents.set(`${sessionID}:${agentID}`, true);
  }

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {boolean}
   */
  isAgentActive(sessionID, agentID) {
    return !!this._activeAgents.get(`${sessionID}:${agentID}`);
  }

  /**
   * @param {string} sessionID
   * @returns {string[]}
   */
  getActiveAgents(sessionID) {
    let agents = [];

    for (let [key] of this._activeAgents) {
      if (key.startsWith(`${sessionID}:`))
        agents.push(key.slice(sessionID.length + 1));
    }

    return agents;
  }

  // ---------------------------------------------------------------------------
  // Pending Trigger Queue
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {void}
   */
  queueTrigger(sessionID, agentID) {
    if (!this._pendingTriggers.has(sessionID))
      this._pendingTriggers.set(sessionID, []);

    this._pendingTriggers.get(sessionID).push({ agentID });
  }

  /**
   * @param {string} sessionID
   * @returns {{ agentID: string }|null}
   */
  dequeueTrigger(sessionID) {
    let queue = this._pendingTriggers.get(sessionID);
    if (!queue || queue.length === 0) {
      this._pendingTriggers.delete(sessionID);
      return null;
    }

    let entry = queue.shift();

    if (queue.length === 0)
      this._pendingTriggers.delete(sessionID);

    return entry;
  }

  /**
   * @param {string} sessionID
   * @returns {void}
   */
  clearTriggers(sessionID) {
    this._pendingTriggers.delete(sessionID);
  }

  /**
   * @param {string} sessionID
   * @returns {boolean}
   */
  hasPendingTriggers(sessionID) {
    let queue = this._pendingTriggers.get(sessionID);
    return !!queue && queue.length > 0;
  }

  /**
   * @param {string} sessionID
   * @returns {Array<{ agentID: string }>}
   */
  getPendingTriggers(sessionID) {
    return this._pendingTriggers.get(sessionID) || [];
  }

  // ---------------------------------------------------------------------------
  // connectToInteractionLoop
  // ---------------------------------------------------------------------------
  /**
   * Subscribes to InteractionLoop events and triggers the next queued agent
   * when an interaction completes.
   * @param {object} interactionLoop
   * @param {AgentResolver} agentResolver
   * @returns {void}
   */
  connectToInteractionLoop(interactionLoop, agentResolver) {
    this._agentResolver = agentResolver;

    this._onInteractionEnd = async ({ sessionID, agentID }) => {
      if (!sessionID)
        return;

      if (agentID)
        this.markComplete(sessionID, agentID);

      await this._triggerNext(sessionID);
    };

    this._onScheduleCancel = ({ sessionID }) => {
      if (sessionID)
        this.clearTriggers(sessionID);
    };

    interactionLoop.on('interaction:end', this._onInteractionEnd);
    this.on('schedule:cancel', this._onScheduleCancel);
  }

  /**
   * @returns {void}
   */
  disconnectFromInteractionLoop() {
    if (this._onInteractionEnd) {
      this._interactionLoop.removeListener('interaction:end', this._onInteractionEnd);
      this._onInteractionEnd = null;
    }

    if (this._onScheduleCancel) {
      this.removeListener('schedule:cancel', this._onScheduleCancel);
      this._onScheduleCancel = null;
    }

    this._agentResolver = null;
  }

  // ---------------------------------------------------------------------------
  // _triggerNext — fire ALL available agents concurrently
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @returns {Promise<void>}
   */
  async _triggerNext(sessionID) {
    let toTrigger = [];
    let deferred  = [];

    // Drain all pending triggers, partition into ready vs already-active
    let entry;
    while ((entry = this.dequeueTrigger(sessionID))) {
      if (this._interactionLoop.isActive(sessionID, entry.agentID))
        deferred.push(entry);
      else
        toTrigger.push(entry);
    }

    // Re-queue deferred agents (retried on next interaction:end)
    for (let d of deferred)
      this.queueTrigger(sessionID, d.agentID);

    if (toTrigger.length === 0) {
      if (this.getActiveAgents(sessionID).length === 0)
        this.clearResolveContext(sessionID);

      return;
    }

    // Fire all available agents concurrently (non-blocking)
    for (let agent of toTrigger) {
      this._triggerAgent(sessionID, agent.agentID).catch((error) => {
        this.emit('trigger:error', { sessionID, agentID: agent.agentID, error });
        this.markComplete(sessionID, agent.agentID);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // _triggerAgent — resolve and start interaction for a secondary agent
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {Promise<void>}
   */
  async _triggerAgent(sessionID, agentID) {
    if (!this._agentResolver)
      throw new Error('SessionScheduler not connected to InteractionLoop');

    let resolveContext = this.getResolveContext(sessionID) || {};
    let { agentPlugin, resolvedAgent } = await this._agentResolver.resolve(agentID, resolveContext);
    let { checkPermission, executeTool } = this._agentResolver.buildCallbacks(resolvedAgent, sessionID);

    await this._interactionLoop.startInteraction(sessionID, {
      agentPlugin,
      agent:          resolvedAgent,
      userMessage:    null,
      authorType:     'agent',
      authorID:       agentID,
      checkPermission,
      executeTool,
    });
  }
}
