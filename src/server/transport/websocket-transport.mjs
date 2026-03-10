'use strict';

import { WebSocketServer } from 'ws';

// =============================================================================
// WebSocketTransport
// =============================================================================
// Sits alongside the existing SSE transport. Provides real-time frame
// streaming over WebSocket connections with reconnection support.
//
// Protocol:
//   Client connects to /api/v2/ws with JWT in query string (?token=xxx)
//   Client sends: { type: 'subscribe', sessionID, lastSeenOrder? }
//   Server sends:  { type: 'frame', frame }
//   Server sends:  { type: 'replay-complete' } after replaying missed frames
//   Server sends:  { type: 'interaction:start', sessionID, interactionID }
//   Server sends:  { type: 'interaction:end', sessionID, interactionID }
//   Server sends:  { type: 'error', message }
// =============================================================================

export class WebSocketTransport {
  constructor(context) {
    if (!context)
      throw new Error('WebSocketTransport requires a CascadingContext');

    this._context = context;
    this._wss     = null;

    // sessionID -> Set<WebSocket>
    this._peers = new Map();

    // Bound event handlers for cleanup
    this._frameHandler            = null;
    this._interactionStartHandler = null;
    this._interactionEndHandler   = null;
    this._pingInterval            = null;
  }

  // ---------------------------------------------------------------------------
  // start — attach to an HTTP server
  // ---------------------------------------------------------------------------

  start(httpServer) {
    if (this._wss)
      throw new Error('WebSocketTransport already started');

    this._wss = new WebSocketServer({
      server: httpServer,
      path:   '/api/v2/ws',
    });

    this._wss.on('connection', (ws, req) => this._handleConnection(ws, req));

    // Start ping/pong interval (30 seconds)
    this._pingInterval = setInterval(() => {
      for (let ws of this._wss.clients) {
        if (ws._isAlive === false) {
          ws.terminate();
          continue;
        }

        ws._isAlive = false;
        ws.ping();
      }
    }, 30000);

    // Subscribe to InteractionLoop events
    let interactionLoop = this._context.getProperty('interactionLoop');
    if (interactionLoop) {
      this._frameHandler = ({ sessionID, frame }) => {
        this._broadcastToSession(sessionID, { type: 'frame', frame });
      };

      this._interactionStartHandler = ({ sessionID, interactionID }) => {
        this._broadcastToSession(sessionID, { type: 'interaction:start', sessionID, interactionID });
      };

      this._interactionEndHandler = ({ sessionID, interactionID }) => {
        this._broadcastToSession(sessionID, { type: 'interaction:end', sessionID, interactionID });
      };

      interactionLoop.on('frame', this._frameHandler);
      interactionLoop.on('interaction:start', this._interactionStartHandler);
      interactionLoop.on('interaction:end', this._interactionEndHandler);
    }
  }

  // ---------------------------------------------------------------------------
  // stop — shut down all connections
  // ---------------------------------------------------------------------------

  stop() {
    // Clean up ping interval
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }

    // Unsubscribe from InteractionLoop events
    let interactionLoop = this._context.getProperty('interactionLoop');
    if (interactionLoop) {
      if (this._frameHandler)
        interactionLoop.removeListener('frame', this._frameHandler);

      if (this._interactionStartHandler)
        interactionLoop.removeListener('interaction:start', this._interactionStartHandler);

      if (this._interactionEndHandler)
        interactionLoop.removeListener('interaction:end', this._interactionEndHandler);
    }

    // Close all client connections
    for (let [, peers] of this._peers) {
      for (let ws of peers) {
        try {
          ws.close(1001, 'Server shutting down');
        } catch (_error) {
          // Ignore close errors
        }
      }
    }

    this._peers.clear();

    // Close WebSocket server
    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }
  }

  // ---------------------------------------------------------------------------
  // _handleConnection — authenticate and set up message handling
  // ---------------------------------------------------------------------------

  _handleConnection(ws, req) {
    // Extract token from query string
    let url   = new URL(req.url, 'http://localhost');
    let token = url.searchParams.get('token');

    if (!token) {
      this._sendError(ws, 'Authentication required');
      ws.close(4001, 'Authentication required');

      return;
    }

    // Verify JWT
    let authService = this._context.getProperty('authService');
    let decoded;

    try {
      decoded = authService.verifyToken(token);
    } catch (_error) {
      this._sendError(ws, 'Invalid token');
      ws.close(4001, 'Invalid token');

      return;
    }

    // Attach user info to the websocket
    ws._userID         = decoded.sub;
    ws._organizationID = decoded.org;
    ws._isAlive        = true;

    // Track pong responses for keep-alive
    ws.on('pong', () => { ws._isAlive = true; });

    // Handle messages
    ws.on('message', (data) => this._handleMessage(ws, data));

    // Clean up on close
    ws.on('close', () => this._handleClose(ws));
  }

  // ---------------------------------------------------------------------------
  // _handleMessage — process client messages
  // ---------------------------------------------------------------------------

  async _handleMessage(ws, data) {
    let message;

    try {
      message = JSON.parse(data.toString());
    } catch (_error) {
      this._sendError(ws, 'Invalid JSON');

      return;
    }

    if (message.type === 'subscribe')
      await this._handleSubscribe(ws, message);
  }

  // ---------------------------------------------------------------------------
  // _handleSubscribe — subscribe to a session's frames
  // ---------------------------------------------------------------------------

  async _handleSubscribe(ws, message) {
    let sessionID     = message.sessionID;
    let lastSeenOrder = message.lastSeenOrder;

    if (!sessionID) {
      this._sendError(ws, 'sessionID is required');

      return;
    }

    // Remove from any previous session
    this._removeFromAllSessions(ws);

    // Add to new session
    if (!this._peers.has(sessionID))
      this._peers.set(sessionID, new Set());

    this._peers.get(sessionID).add(ws);
    ws._sessionID = sessionID;

    // Replay missed frames if lastSeenOrder is provided
    if (lastSeenOrder != null) {
      let framePersistence = this._context.getProperty('framePersistence');

      if (framePersistence) {
        try {
          let frames = await framePersistence.loadFrames(sessionID, {
            afterOrder: lastSeenOrder,
          });

          for (let frame of frames)
            this._send(ws, { type: 'frame', frame });
        } catch (error) {
          this._sendError(ws, `Replay failed: ${error.message}`);
        }
      }

      this._send(ws, { type: 'replay-complete' });
    }

    this._send(ws, { type: 'subscribed', sessionID });
  }

  // ---------------------------------------------------------------------------
  // _handleClose — clean up on disconnect
  // ---------------------------------------------------------------------------

  _handleClose(ws) {
    this._removeFromAllSessions(ws);
  }

  // ---------------------------------------------------------------------------
  // Broadcasting
  // ---------------------------------------------------------------------------

  _broadcastToSession(sessionID, message) {
    let peers = this._peers.get(sessionID);
    if (!peers)
      return;

    let payload = JSON.stringify(message);

    for (let ws of peers) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(payload);
        } catch (_error) {
          // Ignore send errors; close handler will clean up
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _send(ws, message) {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify(message));
  }

  _sendError(ws, errorMessage) {
    this._send(ws, { type: 'error', message: errorMessage });
  }

  _removeFromAllSessions(ws) {
    for (let [sessionID, peers] of this._peers) {
      peers.delete(ws);

      if (peers.size === 0)
        this._peers.delete(sessionID);
    }
  }

  // ---------------------------------------------------------------------------
  // State Queries
  // ---------------------------------------------------------------------------

  getConnectedPeers(sessionID) {
    let peers = this._peers.get(sessionID);

    return peers ? peers.size : 0;
  }

  isStarted() {
    return this._wss !== null;
  }
}
