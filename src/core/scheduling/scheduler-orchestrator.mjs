'use strict';

import { EventEmitter } from 'node:events';

// =============================================================================
// Scheduler Orchestrator
// =============================================================================
// Glue component that wires the SessionScheduler into the live interaction
// flow. Listens to InteractionLoop events and coordinates the multi-agent
// scheduling lifecycle:
//
//   commit          → calls scheduler.onCommit(), queues pending triggers,
//                     then fires available agents concurrently
//   interaction:end → calls scheduler.markComplete(), fires remaining agents
//   schedule:cancel → clears pending triggers for session
//
// Concurrency: agents in the same session run concurrently. Per-agent active
// checks prevent double-triggering the same agent, while different agents
// execute in parallel. This lets users see all agents "thinking" at once.
//
// Infinite loop prevention: only schedules agents on user-authored commits.
// Agent and system commits are ignored to prevent ping-pong loops and
// error-triggered cascades.
//
// Race condition prevention: commit events fire synchronously from _createFrame
// inside startInteraction, but _handleCommit is async (calls DB). The
// interaction:end event can fire before _handleCommit finishes, so
// _handleInteractionEnd would see an empty queue. We solve this with a
// per-session commit barrier: a promise that _handleInteractionEnd awaits
// before checking the queue.
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

    // sessionID → Promise — in-flight commit handling (race condition barrier)
    this._commitBarriers = new Map();

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
    this._commitBarriers.clear();
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  _handleCommit({ sessionID, commit }) {
    if (!sessionID || !commit)
      return;

    // Only schedule agents on user-authored commits. Agent and system commits
    // must be ignored to prevent ping-pong loops and error-triggered cascades.
    if (commit.authorType !== 'user')
      return;

    // Store the commit processing promise as a barrier so interaction:end
    // can await it before checking the queue.
    let barrier = this._processCommit(sessionID, commit);
    this._commitBarriers.set(sessionID, barrier);

    // Clean up barrier when done (don't leave stale promises)
    barrier.then(() => {
      if (this._commitBarriers.get(sessionID) === barrier)
        this._commitBarriers.delete(sessionID);
    });
  }

  async _processCommit(sessionID, commit) {
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

    // Trigger available agents immediately — secondary agents start
    // concurrently with the primary agent (which is already running).
    this._triggerNext(sessionID);
  }

  async _handleInteractionEnd({ sessionID, agentID }) {
    if (!sessionID)
      return;

    // Wait for any in-flight commit handling to finish before checking the
    // queue. This prevents the race where interaction:end fires before
    // _handleCommit has finished populating _pendingTriggers.
    let barrier = this._commitBarriers.get(sessionID);
    if (barrier)
      await barrier;

    // Mark agent as complete in the scheduler
    if (agentID)
      this._scheduler.markComplete(sessionID, agentID);

    // Trigger any remaining queued agents
    this._triggerNext(sessionID);
  }

  _handleScheduleCancel({ sessionID }) {
    if (sessionID)
      this._pendingTriggers.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // _triggerNext — fire all available agents concurrently
  // ---------------------------------------------------------------------------

  _triggerNext(sessionID) {
    let queue = this._pendingTriggers.get(sessionID);
    if (!queue || queue.length === 0) {
      this._pendingTriggers.delete(sessionID);
      return;
    }

    // Partition: agents that can run now vs. those already active
    let toTrigger = [];
    let deferred  = [];

    for (let entry of queue) {
      if (this._interactionLoop.isActive(sessionID, entry.agentID))
        deferred.push(entry);
      else
        toTrigger.push(entry);
    }

    // Update the queue with agents that must wait
    if (deferred.length > 0)
      this._pendingTriggers.set(sessionID, deferred);
    else
      this._pendingTriggers.delete(sessionID);

    // Fire all available agents concurrently (non-blocking).
    // Each agent's completion emits interaction:end which calls
    // _handleInteractionEnd → _triggerNext to drain remaining deferred agents.
    for (let entry of toTrigger) {
      this._triggerAgent(sessionID, entry.agentID).catch((error) => {
        this.emit('trigger:error', { sessionID, agentID: entry.agentID, error });
        this._scheduler.markComplete(sessionID, entry.agentID);
      });
    }
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
