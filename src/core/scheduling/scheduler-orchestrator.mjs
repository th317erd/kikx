'use strict';

import { EventEmitter } from 'node:events';

// =============================================================================
// Scheduler Orchestrator
// =============================================================================
// Glue component that wires the SessionScheduler into the live interaction
// flow. Listens to InteractionLoop events and coordinates the multi-agent
// scheduling lifecycle:
//
//   commit          → calls scheduler.onCommit(), queues pending triggers
//   interaction:end → calls scheduler.markComplete(), triggers next agent
//   schedule:cancel → clears pending triggers for session
//
// Infinite loop prevention: only schedules agents on non-agent commits (user
// messages, system events). Agent-authored commits are ignored.
// =============================================================================

export class SchedulerOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();

    this._scheduler       = options.scheduler;
    this._agentResolver   = options.agentResolver;
    this._interactionLoop = options.interactionLoop;

    if (!this._scheduler)
      throw new Error('SchedulerOrchestrator requires scheduler');

    if (!this._agentResolver)
      throw new Error('SchedulerOrchestrator requires agentResolver');

    if (!this._interactionLoop)
      throw new Error('SchedulerOrchestrator requires interactionLoop');

    // sessionID → [{ agentID }] — agents queued to trigger
    this._pendingTriggers = new Map();

    // Bound handlers for cleanup
    this._onCommit          = this._handleCommit.bind(this);
    this._onInteractionEnd  = this._handleInteractionEnd.bind(this);
    this._onScheduleCancel  = this._handleScheduleCancel.bind(this);
  }

  // ---------------------------------------------------------------------------
  // start / stop
  // ---------------------------------------------------------------------------

  start() {
    this._interactionLoop.on('commit', this._onCommit);
    this._interactionLoop.on('interaction:end', this._onInteractionEnd);
    this._scheduler.on('schedule:cancel', this._onScheduleCancel);
  }

  stop() {
    this._interactionLoop.removeListener('commit', this._onCommit);
    this._interactionLoop.removeListener('interaction:end', this._onInteractionEnd);
    this._scheduler.removeListener('schedule:cancel', this._onScheduleCancel);
    this._pendingTriggers.clear();
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  async _handleCommit({ sessionID, commit }) {
    if (!sessionID || !commit)
      return;

    // Only schedule agents on non-agent commits (user messages, system events).
    // Agent-authored commits must be ignored to prevent A→B→A→B ping-pong.
    if (commit.authorType === 'agent')
      return;

    let scheduled = await this._scheduler.onCommit(sessionID, commit);

    if (!scheduled || scheduled.length === 0)
      return;

    // Queue scheduled agents as pending triggers.
    // The first agent is already being handled by the controller (it's the
    // primary agent the user explicitly targeted). Queue the rest.
    // We don't know which agent the controller is running, so queue all and
    // let _triggerNext skip agents that are already active.
    if (!this._pendingTriggers.has(sessionID))
      this._pendingTriggers.set(sessionID, []);

    let queue = this._pendingTriggers.get(sessionID);

    for (let entry of scheduled)
      queue.push({ agentID: entry.agentID });
  }

  async _handleInteractionEnd({ sessionID, agentID }) {
    if (!sessionID)
      return;

    // Mark agent as complete in the scheduler
    if (agentID)
      this._scheduler.markComplete(sessionID, agentID);

    // Trigger next queued agent
    await this._triggerNext(sessionID);
  }

  _handleScheduleCancel({ sessionID }) {
    if (sessionID)
      this._pendingTriggers.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // _triggerNext — pop next pending agent and start interaction
  // ---------------------------------------------------------------------------

  async _triggerNext(sessionID) {
    let queue = this._pendingTriggers.get(sessionID);
    if (!queue || queue.length === 0) {
      this._pendingTriggers.delete(sessionID);
      return;
    }

    // Skip agents that are already active (e.g., the primary agent from controller)
    while (queue.length > 0) {
      let entry = queue.shift();

      if (this._scheduler.isAgentActive(sessionID, entry.agentID))
        continue;

      // Also skip if the interaction loop already has an active interaction
      if (this._interactionLoop.isActive(sessionID)) {
        // Put it back and wait — it will be retried on next interaction:end
        queue.unshift(entry);
        return;
      }

      try {
        await this._triggerAgent(sessionID, entry.agentID);
      } catch (error) {
        this.emit('trigger:error', { sessionID, agentID: entry.agentID, error });
        // Mark complete so the scheduler doesn't think this agent is still running
        this._scheduler.markComplete(sessionID, entry.agentID);
      }

      // Only trigger one agent at a time — sequential execution
      return;
    }

    // Queue exhausted
    this._pendingTriggers.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // _triggerAgent — resolve and start interaction for a secondary agent
  // ---------------------------------------------------------------------------

  async _triggerAgent(sessionID, agentID) {
    let resolveContext = this._scheduler.getResolveContext(sessionID) || {};

    let { agentPlugin, resolvedAgent } = await this._agentResolver.resolve(agentID, resolveContext);
    let { checkPermission, executeTool } = this._agentResolver.buildCallbacks(resolvedAgent, sessionID);

    // Start interaction with no userMessage — the agent responds to existing
    // frames it hasn't processed yet (detected via its agent ref).
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

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  getPendingTriggers(sessionID) {
    return this._pendingTriggers.get(sessionID) || [];
  }

  hasPendingTriggers(sessionID) {
    let queue = this._pendingTriggers.get(sessionID);
    return !!queue && queue.length > 0;
  }
}
