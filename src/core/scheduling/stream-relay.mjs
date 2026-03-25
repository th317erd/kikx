'use strict';

import { EventEmitter } from 'node:events';

// =============================================================================
// StreamRelay — cross-session streaming event forwarder
// =============================================================================
// When an agent in Session X triggers work in Session Y (via postToSession),
// the user watching Session X sees nothing until Y finishes. StreamRelay
// forwards streaming events (delta, reflection-delta) from Y back to X so
// the user gets real-time feedback.
//
// Events emitted:
//   'relay:delta' — { sourceSessionID, targetSessionID, agentID, content, authorType, authorID }
//   'relay:reflection-delta' — same shape
//
// Auto-destroys relays on interaction:end from the target session.
// =============================================================================

export class StreamRelay extends EventEmitter {
  constructor(interactionLoop) {
    super();

    if (!interactionLoop)
      throw new Error('StreamRelay requires an InteractionLoop');

    this._interactionLoop = interactionLoop;

    // Map<string, { onDelta, onReflectionDelta, onEnd }> keyed by `${source}:${target}`
    this._relays = new Map();
  }

  // ---------------------------------------------------------------------------
  // createRelay — start forwarding events from targetSessionID to sourceSessionID
  // ---------------------------------------------------------------------------

  createRelay(sourceSessionID, targetSessionID) {
    if (!sourceSessionID)
      throw new Error('sourceSessionID is required');

    if (!targetSessionID)
      throw new Error('targetSessionID is required');

    let key = `${sourceSessionID}:${targetSessionID}`;

    // Idempotent: if relay already exists, skip
    if (this._relays.has(key))
      return;

    let onDelta = ({ sessionID, interactionID, content, authorType, authorID }) => {
      if (sessionID !== targetSessionID)
        return;

      this.emit('relay:Delta', {
        sourceSessionID,
        targetSessionID,
        interactionID,
        content,
        authorType: authorType || null,
        authorID:   authorID || null,
      });
    };

    let onReflectionDelta = ({ sessionID, interactionID, content, authorType, authorID }) => {
      if (sessionID !== targetSessionID)
        return;

      this.emit('relay:ReflectionDelta', {
        sourceSessionID,
        targetSessionID,
        interactionID,
        content,
        authorType: authorType || null,
        authorID:   authorID || null,
      });
    };

    let onEnd = ({ sessionID }) => {
      if (sessionID !== targetSessionID)
        return;

      this.destroyRelay(sourceSessionID, targetSessionID);
    };

    this._interactionLoop.on('Delta', onDelta);
    this._interactionLoop.on('ReflectionDelta', onReflectionDelta);
    this._interactionLoop.on('interaction:end', onEnd);

    this._relays.set(key, { onDelta, onReflectionDelta, onEnd });
  }

  // ---------------------------------------------------------------------------
  // destroyRelay — stop forwarding
  // ---------------------------------------------------------------------------

  destroyRelay(sourceSessionID, targetSessionID) {
    let key   = `${sourceSessionID}:${targetSessionID}`;
    let relay = this._relays.get(key);

    if (!relay)
      return false;

    this._interactionLoop.off('Delta', relay.onDelta);
    this._interactionLoop.off('ReflectionDelta', relay.onReflectionDelta);
    this._interactionLoop.off('interaction:end', relay.onEnd);

    this._relays.delete(key);
    return true;
  }

  // ---------------------------------------------------------------------------
  // destroyAll — clean up all relays
  // ---------------------------------------------------------------------------

  destroyAll() {
    for (let [key, relay] of this._relays) {
      this._interactionLoop.off('Delta', relay.onDelta);
      this._interactionLoop.off('ReflectionDelta', relay.onReflectionDelta);
      this._interactionLoop.off('interaction:end', relay.onEnd);
    }

    this._relays.clear();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  hasRelay(sourceSessionID, targetSessionID) {
    return this._relays.has(`${sourceSessionID}:${targetSessionID}`);
  }

  getRelayCount() {
    return this._relays.size;
  }
}
