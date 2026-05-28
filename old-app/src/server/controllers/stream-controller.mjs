'use strict';

// =============================================================================
// StreamController — SSE event stream for a session
// =============================================================================
// Returns a Promise that blocks until the client disconnects. This prevents
// Mythix from calling response.end() and closing the long-lived SSE connection.
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class StreamController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions/:sessionID/stream
  // ---------------------------------------------------------------------------

  async connect({ params }) {
    let sessionID       = params.sessionID;
    let interactionLoop = this.getInteractionLoop();
    let response        = this.response;
    let request         = this.request;

    // Set SSE headers
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');

    // Signal to Mythix that we're handling the response manually
    response.statusMessage = 'Streaming';

    // Send initial ping
    response.write('event: connected\ndata: {}\n\n');

    // Frame listener
    let onFrame = ({ sessionID: sid, frame }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
    };

    // Interaction lifecycle
    let onInteractionStart = ({ sessionID: sid, interactionID, agentID }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: interaction:start\ndata: ${JSON.stringify({ interactionID, agentID: agentID || null })}\n\n`);
    };

    let onInteractionEnd = ({ sessionID: sid, interactionID, agentID }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: interaction:end\ndata: ${JSON.stringify({ interactionID, agentID: agentID || null })}\n\n`);
    };

    let onPermissionRequest = ({ sessionID: sid, frameID, toolName }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: permission:request\ndata: ${JSON.stringify({ frameID, toolName })}\n\n`);
    };

    // Streaming deltas (transient, not persisted)
    let onDelta = ({ sessionID: sid, interactionID: iid, content, authorType: aType, authorID: aID }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: Delta\ndata: ${JSON.stringify({ interactionID: iid, content, authorType: aType || null, authorID: aID || null })}\n\n`);
    };

    let onReflectionDelta = ({ sessionID: sid, interactionID: iid, content, authorType: aType, authorID: aID }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: ReflectionDelta\ndata: ${JSON.stringify({ interactionID: iid, content, authorType: aType || null, authorID: aID || null })}\n\n`);
    };

    let onUsage = ({ sessionID: sid, interactionID: iid, usage, serviceType, isFinal }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: usage\ndata: ${JSON.stringify({ interactionID: iid, usage, serviceType: serviceType || null, isFinal: !!isFinal })}\n\n`);
    };

    // Commit listener — enriched commits for client-side FrameManager
    let onCommit = ({ sessionID: sid, commit }) => {
      if (sid !== sessionID)
        return;

      response.write(`event: commit\ndata: ${JSON.stringify(commit)}\n\n`);
    };

    // Cross-session relay events
    let streamRelay = this.getStreamRelay ? this.getStreamRelay() : null;

    let onRelayDelta = ({ sourceSessionID, targetSessionID, interactionID, content, authorType, authorID }) => {
      if (sourceSessionID !== sessionID)
        return;

      response.write(`event: relay:Delta\ndata: ${JSON.stringify({ sourceSessionID, targetSessionID, interactionID, content, authorType: authorType || null, authorID: authorID || null })}\n\n`);
    };

    let onRelayReflectionDelta = ({ sourceSessionID, targetSessionID, interactionID, content, authorType, authorID }) => {
      if (sourceSessionID !== sessionID)
        return;

      response.write(`event: relay:ReflectionDelta\ndata: ${JSON.stringify({ sourceSessionID, targetSessionID, interactionID, content, authorType: authorType || null, authorID: authorID || null })}\n\n`);
    };

    // Attach listeners
    interactionLoop.on('frame', onFrame);
    interactionLoop.on('commit', onCommit);
    interactionLoop.on('interaction:start', onInteractionStart);
    interactionLoop.on('interaction:end', onInteractionEnd);
    interactionLoop.on('permission:request', onPermissionRequest);
    interactionLoop.on('Delta', onDelta);
    interactionLoop.on('ReflectionDelta', onReflectionDelta);
    interactionLoop.on('interaction:usage', onUsage);

    if (streamRelay) {
      streamRelay.on('relay:Delta', onRelayDelta);
      streamRelay.on('relay:ReflectionDelta', onRelayReflectionDelta);
    }

    // Clean up on disconnect
    let cleanup = () => {
      interactionLoop.off('frame', onFrame);
      interactionLoop.off('commit', onCommit);
      interactionLoop.off('interaction:start', onInteractionStart);
      interactionLoop.off('interaction:end', onInteractionEnd);
      interactionLoop.off('permission:request', onPermissionRequest);
      interactionLoop.off('Delta', onDelta);
      interactionLoop.off('ReflectionDelta', onReflectionDelta);
      interactionLoop.off('interaction:usage', onUsage);

      if (streamRelay) {
        streamRelay.off('relay:Delta', onRelayDelta);
        streamRelay.off('relay:ReflectionDelta', onRelayReflectionDelta);
      }
    };

    // Store cleanup reference for testing
    response._sseCleanup = cleanup;

    // Return a Promise that resolves only when the client disconnects.
    // This blocks Mythix from reaching its response finalization code
    // (which would call response.end() and close the SSE connection).
    return new Promise((resolve) => {
      let onClose = () => {
        cleanup();

        if (!response.writableEnded)
          response.end();

        resolve();
      };

      if (request.on)
        request.on('close', onClose);
    });
  }
}
