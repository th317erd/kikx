'use strict';

// =============================================================================
// StreamController — SSE event stream for a session
// =============================================================================
// Writes directly to the response (does NOT return { data }).
// Mythix will see that headers are already sent and skip JSON serialization.
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

    // Attach listeners
    interactionLoop.on('frame', onFrame);
    interactionLoop.on('interaction:start', onInteractionStart);
    interactionLoop.on('interaction:end', onInteractionEnd);
    interactionLoop.on('permission:request', onPermissionRequest);

    // Clean up on disconnect
    let cleanup = () => {
      interactionLoop.off('frame', onFrame);
      interactionLoop.off('interaction:start', onInteractionStart);
      interactionLoop.off('interaction:end', onInteractionEnd);
      interactionLoop.off('permission:request', onPermissionRequest);
    };

    if (request.on)
      request.on('close', cleanup);

    // Store cleanup reference for testing
    response._sseCleanup = cleanup;
  }
}
