'use strict';

import { EventEmitter } from 'node:events';
import XID              from 'xid-js';

// =============================================================================
// DiscussionOrchestrator
// =============================================================================
// Manages multi-coordinator discussion rounds when a user message arrives in
// a session with 2+ coordinator-role participants. Coordinators take turns
// discussing in round-robin fashion, producing `discussion` type frames. When
// one claims the response, that coordinator generates the final reply.
//
// State machine per session:
//   IDLE -> DISCUSSING -> CLAIMED -> RESPONDING -> IDLE
//
// Events:
//   'discussion:start'  — { sessionID, coordinators, maxRounds }
//   'discussion:round'  — { sessionID, round, agentID }
//   'discussion:claim'  — { sessionID, agentID, round }
//   'discussion:end'    — { sessionID, claimedByAgentID }
//   'discussion:bypass' — { sessionID, targetAgentID, reason }
// =============================================================================

const STATE_IDLE       = 'idle';
const STATE_DISCUSSING = 'discussing';
const STATE_CLAIMED    = 'claimed';
const STATE_RESPONDING = 'responding';

function generateFrameID() {
  return `frm_${XID.next()}`;
}

export class DiscussionOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();

    this._sessionManager  = options.sessionManager;
    this._interactionLoop = options.interactionLoop;
    this._agentResolver   = options.agentResolver;

    if (!this._sessionManager)
      throw new Error('DiscussionOrchestrator requires sessionManager');

    if (!this._interactionLoop)
      throw new Error('DiscussionOrchestrator requires interactionLoop');

    this._maxRounds = options.maxRounds || 3;

    // sessionID → { state, coordinators, round, currentIndex, claimedByAgentID, commit }
    this._sessions = new Map();
  }

  // ---------------------------------------------------------------------------
  // getState
  // ---------------------------------------------------------------------------

  getState(sessionID) {
    let session = this._sessions.get(sessionID);
    return (session) ? session.state : STATE_IDLE;
  }

  // ---------------------------------------------------------------------------
  // startDiscussion
  // ---------------------------------------------------------------------------
  // Called by SchedulingPlugin when a user commit arrives in a session with
  // 2+ coordinator participants.
  //
  // coordinators: Array of { agentID, participantID }
  // commit: the user-authored commit that triggered the discussion
  // ---------------------------------------------------------------------------

  async startDiscussion(sessionID, coordinators, commit) {
    if (!sessionID)
      throw new Error('sessionID is required');

    if (!coordinators || coordinators.length < 2)
      throw new Error('Discussion requires at least 2 coordinators');

    // Check for @mention bypass in the user message
    let mentionTarget = this._checkMention(sessionID, commit, coordinators);
    if (mentionTarget) {
      this.emit('discussion:bypass', { sessionID, targetAgentID: mentionTarget, reason: 'mention' });
      return { bypassed: true, targetAgentID: mentionTarget };
    }

    let discussion = {
      state:            STATE_DISCUSSING,
      coordinators,
      round:            1,
      currentIndex:     0,
      claimedByAgentID: null,
      commit,
    };

    this._sessions.set(sessionID, discussion);

    this.emit('discussion:start', {
      sessionID,
      coordinators: coordinators.map((c) => c.agentID),
      maxRounds:    this._maxRounds,
    });

    // Start first coordinator's turn
    await this._nextTurn(sessionID);

    return { bypassed: false };
  }

  // ---------------------------------------------------------------------------
  // _checkMention — look for @agentName in user message
  // ---------------------------------------------------------------------------

  _checkMention(sessionID, commit, coordinators) {
    if (!commit || !commit.changes)
      return null;

    let frameManager = this._sessionManager.getFrameManager(sessionID);

    for (let change of commit.changes) {
      let frame = frameManager.getHead(change.frameID);
      if (!frame || frame.type !== 'user-message')
        continue;

      let text = (frame.content && frame.content.text) || '';

      for (let coordinator of coordinators) {
        // Look up agent name
        let agentName = coordinator.agentName || coordinator.agentID;
        if (text.includes(`@${agentName}`))
          return coordinator.agentID;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // _nextTurn — give the next coordinator a discussion turn
  // ---------------------------------------------------------------------------

  async _nextTurn(sessionID) {
    let discussion = this._sessions.get(sessionID);
    if (!discussion || discussion.state !== STATE_DISCUSSING)
      return;

    // Check if we've exceeded max rounds
    if (discussion.round > this._maxRounds) {
      // Auto-claim: first coordinator
      await this._autoClaim(sessionID);
      return;
    }

    let coordinator = discussion.coordinators[discussion.currentIndex];
    if (!coordinator) {
      // Should not happen, but safety fallback
      await this._autoClaim(sessionID);
      return;
    }

    this.emit('discussion:round', {
      sessionID,
      round:   discussion.round,
      agentID: coordinator.agentID,
    });

    // Create a discussion interaction for this coordinator
    await this._runDiscussionTurn(sessionID, coordinator, discussion.round);
  }

  // ---------------------------------------------------------------------------
  // _runDiscussionTurn — trigger the coordinator for a discussion round
  // ---------------------------------------------------------------------------

  async _runDiscussionTurn(sessionID, coordinator, round) {
    if (!this._agentResolver)
      throw new Error('DiscussionOrchestrator requires agentResolver');

    let discussion = this._sessions.get(sessionID);
    if (!discussion)
      return;

    try {
      let resolveContext = {};
      let { agentPlugin, resolvedAgent } = await this._agentResolver.resolve(coordinator.agentID, resolveContext);
      let { checkPermission, executeTool } = this._agentResolver.buildCallbacks(resolvedAgent, sessionID);

      // Set up a one-time handler to process the discussion response
      let onEnd = async ({ sessionID: sid, agentID: endAgentID }) => {
        if (sid !== sessionID)
          return;

        this._interactionLoop.off('interaction:end', onEnd);

        // Check if the coordinator claimed the response
        let currentDiscussion = this._sessions.get(sessionID);
        if (!currentDiscussion || currentDiscussion.state !== STATE_DISCUSSING)
          return;

        // Check the last discussion frame for claimIntent
        let claimed = this._checkClaim(sessionID, coordinator.agentID);

        if (claimed) {
          await this._handleClaim(sessionID, coordinator.agentID);
          return;
        }

        // Advance to next coordinator
        currentDiscussion.currentIndex++;
        if (currentDiscussion.currentIndex >= currentDiscussion.coordinators.length) {
          currentDiscussion.currentIndex = 0;
          currentDiscussion.round++;
        }

        await this._nextTurn(sessionID);
      };

      this._interactionLoop.on('interaction:end', onEnd);

      // Inject discussion context into the interaction
      await this._interactionLoop.startInteraction(sessionID, {
        agentPlugin,
        agent:           resolvedAgent,
        userMessage:     null,
        authorType:      'agent',
        authorID:        coordinator.agentID,
        checkPermission,
        executeTool,
        discussionContext: {
          round,
          maxRounds: this._maxRounds,
          coordinators: discussion.coordinators.map((c) => c.agentID),
        },
      });
    } catch (error) {
      // On error, auto-claim to prevent deadlock
      await this._autoClaim(sessionID);
    }
  }

  // ---------------------------------------------------------------------------
  // _checkClaim — check if the coordinator's response contains a claim
  // ---------------------------------------------------------------------------

  _checkClaim(sessionID, agentID) {
    let frameManager = this._sessionManager.getFrameManager(sessionID);
    let frames       = frameManager.toArray();

    // Look for the most recent discussion frame from this agent with claimIntent
    for (let i = frames.length - 1; i >= 0; i--) {
      let frame = frames[i];
      if (frame.type !== 'discussion')
        continue;

      if (frame.authorID !== agentID)
        continue;

      if (frame.content && frame.content.claimIntent)
        return true;

      // Only check the most recent discussion frame from this agent
      break;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // _handleClaim — coordinator claimed the response
  // ---------------------------------------------------------------------------

  async _handleClaim(sessionID, agentID) {
    let discussion = this._sessions.get(sessionID);
    if (!discussion)
      return;

    discussion.state            = STATE_CLAIMED;
    discussion.claimedByAgentID = agentID;

    this.emit('discussion:claim', { sessionID, agentID, round: discussion.round });

    // Transition to RESPONDING and trigger the claiming coordinator's
    // final response interaction
    discussion.state = STATE_RESPONDING;

    // The claiming coordinator's final response goes through normal
    // scheduling — just queue it
    let sessionScheduler = this._interactionLoop._context.getProperty('sessionScheduler');
    if (sessionScheduler)
      sessionScheduler.queueTrigger(sessionID, agentID);

    this.emit('discussion:end', { sessionID, claimedByAgentID: agentID });
    this._sessions.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // _autoClaim — deadlock prevention
  // ---------------------------------------------------------------------------

  async _autoClaim(sessionID) {
    let discussion = this._sessions.get(sessionID);
    if (!discussion)
      return;

    // First coordinator auto-claims
    let firstCoordinator = discussion.coordinators[0];
    if (!firstCoordinator) {
      this._sessions.delete(sessionID);
      return;
    }

    await this._handleClaim(sessionID, firstCoordinator.agentID);
  }

  // ---------------------------------------------------------------------------
  // cancelDiscussion
  // ---------------------------------------------------------------------------

  cancelDiscussion(sessionID) {
    this._sessions.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // isDiscussing
  // ---------------------------------------------------------------------------

  isDiscussing(sessionID) {
    let session = this._sessions.get(sessionID);
    return !!session && session.state === STATE_DISCUSSING;
  }
}
