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
  constructor(options = {}) {
    super();

    this._sessionManager  = options.sessionManager;
    this._interactionLoop = options.interactionLoop;

    if (!this._sessionManager)
      throw new Error('SessionScheduler requires sessionManager');

    if (!this._interactionLoop)
      throw new Error('SessionScheduler requires interactionLoop');

    // agentID → true while agent is running
    this._activeAgents = new Map();

    // sessionID → { keystore, umk, userId } for secondary agent resolution
    this._resolveContexts = new Map();
  }

  // ---------------------------------------------------------------------------
  // Resolve Context — stores decryption context for secondary agents
  // ---------------------------------------------------------------------------

  setResolveContext(sessionID, context) {
    this._resolveContexts.set(sessionID, context);
  }

  getResolveContext(sessionID) {
    return this._resolveContexts.get(sessionID) || null;
  }

  clearResolveContext(sessionID) {
    this._resolveContexts.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // onCommit
  // ---------------------------------------------------------------------------
  // Called after a commit is created on a session's FrameManager.
  // Determines which agents need to be triggered.
  //
  // Returns: Array of { agentID, newFrames } that were scheduled.
  // ---------------------------------------------------------------------------

  async onCommit(sessionID, commit) {
    if (!sessionID || !commit)
      return [];

    // Check if the commit contains a stop frame — handle cancellation
    // commit.changes are { frameId, operation } records; resolve to actual frames
    let frameManager = this._sessionManager.getFrameManager(sessionID);
    let stopFrames   = [];

    for (let change of (commit.changes || [])) {
      let frame = frameManager.getHead(change.frameId);
      if (frame && frame.type === 'stop')
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
      if (commit.authorId && commit.authorId === agentID) {
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
  // Processes stop frames from a commit. If targetAgentID is set, cancels that
  // specific agent. If null, cancels ALL active agents in the session.
  // ---------------------------------------------------------------------------

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
  // Called when an agent's interaction completes. Clears the active flag.
  // ---------------------------------------------------------------------------

  markComplete(sessionID, agentID) {
    let activeKey = `${sessionID}:${agentID}`;
    this._activeAgents.delete(activeKey);

    // Clear resolve context when no agents remain active for this session
    if (this.getActiveAgents(sessionID).length === 0)
      this.clearResolveContext(sessionID);
  }

  isAgentActive(sessionID, agentID) {
    return !!this._activeAgents.get(`${sessionID}:${agentID}`);
  }

  getActiveAgents(sessionID) {
    let agents = [];

    for (let [key] of this._activeAgents) {
      if (key.startsWith(`${sessionID}:`))
        agents.push(key.slice(sessionID.length + 1));
    }

    return agents;
  }
}
