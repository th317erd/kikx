'use strict';

import { EventEmitter } from 'node:events';

// =============================================================================
// Scheduler Orchestrator
// =============================================================================
// Glue component that wires the SessionScheduler into the live interaction
// flow. Listens to InteractionLoop events and coordinates the multi-agent
// scheduling lifecycle.
// =============================================================================

export class SchedulerOrchestrator extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {import('./session-scheduler.mjs').SessionScheduler} options.scheduler
   * @param {import('./agent-resolver.mjs').AgentResolver} options.agentResolver
   * @param {object} options.interactionLoop
   */
  constructor(options = {}) {
    super();

    /** @type {import('./session-scheduler.mjs').SessionScheduler} */
    this._scheduler       = options.scheduler;
    /** @type {import('./agent-resolver.mjs').AgentResolver} */
    this._agentResolver   = options.agentResolver;
    /** @type {object} */
    this._interactionLoop = options.interactionLoop;

    if (!this._scheduler)
      throw new Error('SchedulerOrchestrator requires scheduler');

    if (!this._agentResolver)
      throw new Error('SchedulerOrchestrator requires agentResolver');

    if (!this._interactionLoop)
      throw new Error('SchedulerOrchestrator requires interactionLoop');

    /** @type {Map<string, Array<{ agentID: string }>>} sessionID → queued triggers */
    this._pendingTriggers = new Map();

    /** @type {Map<string, Promise<void>>} sessionID → in-flight commit barrier */
    this._commitBarriers = new Map();

    // Bound handlers for cleanup
    /** @type {(event: { sessionID: string, commit: import('../types').Commit }) => void} */
    this._onCommit          = this._handleCommit.bind(this);
    /** @type {(event: { sessionID: string, agentID: string }) => Promise<void>} */
    this._onInteractionEnd  = this._handleInteractionEnd.bind(this);
    /** @type {(event: { sessionID: string }) => void} */
    this._onScheduleCancel  = this._handleScheduleCancel.bind(this);
  }

  // ---------------------------------------------------------------------------
  // start / stop
  // ---------------------------------------------------------------------------

  /**
   * @returns {void}
   */
  start() {
    this._interactionLoop.on('commit', this._onCommit);
    this._interactionLoop.on('interaction:end', this._onInteractionEnd);
    this._scheduler.on('schedule:cancel', this._onScheduleCancel);
  }

  /**
   * @returns {void}
   */
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

  /**
   * @param {{ sessionID: string, commit: import('../types').Commit }} event
   * @returns {void}
   */
  _handleCommit({ sessionID, commit }) {
    if (!sessionID || !commit)
      return;

    // Only schedule agents on user-authored commits.
    if (commit.authorType !== 'user')
      return;

    let barrier = this._processCommit(sessionID, commit);
    this._commitBarriers.set(sessionID, barrier);

    barrier.then(() => {
      if (this._commitBarriers.get(sessionID) === barrier)
        this._commitBarriers.delete(sessionID);
    });
  }

  /**
   * @param {string} sessionID
   * @param {import('../types').Commit} commit
   * @returns {Promise<void>}
   */
  async _processCommit(sessionID, commit) {
    let scheduled = await this._scheduler.onCommit(sessionID, commit);

    if (!scheduled || scheduled.length === 0)
      return;

    if (!this._pendingTriggers.has(sessionID))
      this._pendingTriggers.set(sessionID, []);

    let queue = this._pendingTriggers.get(sessionID);

    for (let entry of scheduled)
      queue.push({ agentID: entry.agentID });

    this._triggerNext(sessionID);
  }

  /**
   * @param {{ sessionID: string, agentID: string }} event
   * @returns {Promise<void>}
   */
  async _handleInteractionEnd({ sessionID, agentID }) {
    if (!sessionID)
      return;

    let barrier = this._commitBarriers.get(sessionID);
    if (barrier)
      await barrier;

    if (agentID)
      this._scheduler.markComplete(sessionID, agentID);

    this._triggerNext(sessionID);
  }

  /**
   * @param {{ sessionID: string }} event
   * @returns {void}
   */
  _handleScheduleCancel({ sessionID }) {
    if (sessionID)
      this._pendingTriggers.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // _triggerNext — fire all available agents concurrently
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @returns {void}
   */
  _triggerNext(sessionID) {
    let queue = this._pendingTriggers.get(sessionID);
    if (!queue || queue.length === 0) {
      this._pendingTriggers.delete(sessionID);
      return;
    }

    let toTrigger = [];
    let deferred  = [];

    for (let entry of queue) {
      if (this._interactionLoop.isActive(sessionID, entry.agentID))
        deferred.push(entry);
      else
        toTrigger.push(entry);
    }

    if (deferred.length > 0)
      this._pendingTriggers.set(sessionID, deferred);
    else
      this._pendingTriggers.delete(sessionID);

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

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {Promise<void>}
   */
  async _triggerAgent(sessionID, agentID) {
    let resolveContext = this._scheduler.getResolveContext(sessionID) || {};

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

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @returns {Array<{ agentID: string }>}
   */
  getPendingTriggers(sessionID) {
    return this._pendingTriggers.get(sessionID) || [];
  }

  /**
   * @param {string} sessionID
   * @returns {boolean}
   */
  hasPendingTriggers(sessionID) {
    let queue = this._pendingTriggers.get(sessionID);
    return !!queue && queue.length > 0;
  }
}
