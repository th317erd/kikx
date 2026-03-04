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
  // GET /api/v2/sessions/:sessionId/stream
  // ---------------------------------------------------------------------------

  async connect({ params }) {
    let sessionId       = params.sessionId;
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
    let onFrame = ({ sessionID, frame }) => {
      if (sessionID !== sessionId)
        return;

      response.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
    };

    // Interaction lifecycle
    let onInteractionStart = ({ sessionID, interactionID }) => {
      if (sessionID !== sessionId)
        return;

      response.write(`event: interaction:start\ndata: ${JSON.stringify({ interactionID })}\n\n`);
    };

    let onInteractionEnd = ({ sessionID, interactionID }) => {
      if (sessionID !== sessionId)
        return;

      response.write(`event: interaction:end\ndata: ${JSON.stringify({ interactionID })}\n\n`);
    };

    let onPermissionRequest = ({ sessionID, frameID, toolName }) => {
      if (sessionID !== sessionId)
        return;

      response.write(`event: permission:request\ndata: ${JSON.stringify({ frameID, toolName })}\n\n`);
    };

    // Streaming deltas (transient, not persisted)
    let onDelta = ({ sessionID: sid, interactionID: iid, content }) => {
      if (sid !== sessionId)
        return;

      response.write(`event: delta\ndata: ${JSON.stringify({ interactionID: iid, content })}\n\n`);
    };

    let onReflectionDelta = ({ sessionID: sid, interactionID: iid, content }) => {
      if (sid !== sessionId)
        return;

      response.write(`event: reflection-delta\ndata: ${JSON.stringify({ interactionID: iid, content })}\n\n`);
    };

    let onUsage = ({ sessionID: sid, interactionID: iid, usage }) => {
      if (sid !== sessionId)
        return;

      response.write(`event: usage\ndata: ${JSON.stringify({ interactionID: iid, usage })}\n\n`);
    };

    // Attach listeners
    interactionLoop.on('frame', onFrame);
    interactionLoop.on('interaction:start', onInteractionStart);
    interactionLoop.on('interaction:end', onInteractionEnd);
    interactionLoop.on('permission:request', onPermissionRequest);
    interactionLoop.on('delta', onDelta);
    interactionLoop.on('reflection-delta', onReflectionDelta);
    interactionLoop.on('interaction:usage', onUsage);

    // Clean up on disconnect
    let cleanup = () => {
      interactionLoop.off('frame', onFrame);
      interactionLoop.off('interaction:start', onInteractionStart);
      interactionLoop.off('interaction:end', onInteractionEnd);
      interactionLoop.off('permission:request', onPermissionRequest);
      interactionLoop.off('delta', onDelta);
      interactionLoop.off('reflection-delta', onReflectionDelta);
      interactionLoop.off('interaction:usage', onUsage);
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
