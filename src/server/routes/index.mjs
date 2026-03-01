'use strict';

// =============================================================================
// ServerRoutes
// =============================================================================
// Thin REST endpoint handlers (adapters calling core methods).
// Framework-agnostic: each handler is async (req, res) => { ... }.
//
// Request contract:
//   req.body            — parsed JSON body
//   req.params          — URL params (:id style)
//   req.query           — query string params
//   req.userId          — set by auth middleware
//   req.organizationId  — set by auth middleware
//   req.getUMK()        — set by auth middleware
//   req.headers         — request headers
//
// Response contract:
//   res.json(data)      — send JSON response
//   res.status(code)    — set status code (chainable)
//   res.setHeader(k, v) — set response header
//   res.write(data)     — write chunk (SSE)
//   res.end()           — end response (SSE)
// =============================================================================

export class ServerRoutes {
  constructor({ core, authService, keystore } = {}) {
    if (!core)
      throw new Error('ServerRoutes requires core');

    if (!authService)
      throw new Error('ServerRoutes requires authService');

    if (!keystore)
      throw new Error('ServerRoutes requires keystore');

    this._core        = core;
    this._authService = authService;
    this._keystore    = keystore;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  _getModels() {
    return this._core.getModels();
  }

  _getSessionManager() {
    return this._core.getContext().getProperty('sessionManager');
  }

  _getInteractionLoop() {
    return this._core.getContext().getProperty('interactionLoop');
  }

  _getFramePersistence() {
    return this._core.getContext().getProperty('framePersistence');
  }

  // ---------------------------------------------------------------------------
  // Error wrapper
  // ---------------------------------------------------------------------------

  _wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        let status  = error.status || error.statusCode || 500;
        let message = error.message || 'Internal server error';

        // Known error types get specific status codes
        if (error.code === 'INVALID_EMAIL' || error.code === 'INVALID_PASSWORD')
          status = 400;
        else if (error.code === 'DUPLICATE_EMAIL')
          status = 409;
        else if (error.code === 'INVALID_CREDENTIALS' || error.code === 'MISSING_TOKEN' || error.code === 'AUTH_ERROR')
          status = 401;
        else if (error.name === 'AuthError')
          status = 401;
        else if (message.includes('not found') || message.includes('Not found'))
          status = 404;
        else if (message.includes('is required'))
          status = 400;

        res.status(status).json({ error: message });
      }
    };
  }

  // ===========================================================================
  // Auth Routes — /api/v2/auth/
  // ===========================================================================

  handleRegister() {
    return this._wrap(async (req, res) => {
      let { email, password, organizationName, firstName, lastName } = req.body || {};

      if (!email)
        return res.status(400).json({ error: 'email is required' });

      if (!password)
        return res.status(400).json({ error: 'password is required' });

      let result = await this._authService.register(email, password, {
        organizationName,
        firstName,
        lastName,
      });

      res.status(201).json({
        user:         { id: result.user.id, email: result.user.email, firstName: result.user.firstName, lastName: result.user.lastName },
        token:        result.token,
        organization: { id: result.organization.id, name: result.organization.name },
      });
    });
  }

  handleLogin() {
    return this._wrap(async (req, res) => {
      let { email, password } = req.body || {};

      if (!email)
        return res.status(400).json({ error: 'email is required' });

      if (!password)
        return res.status(400).json({ error: 'password is required' });

      let result = await this._authService.login(email, password);

      res.json({
        user:  { id: result.user.id, email: result.user.email, firstName: result.user.firstName, lastName: result.user.lastName },
        token: result.token,
      });
    });
  }

  handleMe() {
    return this._wrap(async (req, res) => {
      let { User } = this._getModels();
      let user     = await User.where.id.EQ(req.userId).first();

      if (!user)
        return res.status(404).json({ error: 'User not found' });

      res.json({
        id:             user.id,
        email:          user.email,
        firstName:      user.firstName,
        lastName:       user.lastName,
        organizationID: user.organizationID,
      });
    });
  }

  // ===========================================================================
  // Session Routes — /api/v2/sessions/
  // ===========================================================================

  handleListSessions() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();
      let sessions       = await sessionManager.getSessions(req.organizationId, req.query || {});

      res.json({ sessions });
    });
  }

  handleCreateSession() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();
      let session        = await sessionManager.createSession(req.organizationId, req.body || {});

      res.status(201).json({ session });
    });
  }

  handleGetSession() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();
      let session        = await sessionManager.getSession(req.params.id);

      if (!session)
        return res.status(404).json({ error: 'Session not found' });

      res.json({ session });
    });
  }

  handleUpdateSession() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();
      let session        = await sessionManager.updateSession(req.params.id, req.body || {});

      res.json({ session });
    });
  }

  handleDeleteSession() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();

      await sessionManager.deleteSession(req.params.id);

      res.json({ deleted: true });
    });
  }

  handleArchiveSession() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();
      let session        = await sessionManager.archiveSession(req.params.id);

      res.json({ session });
    });
  }

  handleReviveSession() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();
      let session        = await sessionManager.reviveSession(req.params.id);

      res.json({ session });
    });
  }

  // ===========================================================================
  // Participant Routes — /api/v2/sessions/:sessionId/participants/
  // ===========================================================================

  handleListParticipants() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();
      let participants   = await sessionManager.getParticipants(req.params.sessionId);

      res.json({ participants });
    });
  }

  handleAddParticipant() {
    return this._wrap(async (req, res) => {
      let { agentId, alias, overrides } = req.body || {};

      if (!agentId)
        return res.status(400).json({ error: 'agentId is required' });

      let sessionManager = this._getSessionManager();
      let participant    = await sessionManager.addParticipant(
        req.params.sessionId,
        agentId,
        { alias, overrides },
      );

      res.status(201).json({ participant });
    });
  }

  handleRemoveParticipant() {
    return this._wrap(async (req, res) => {
      let sessionManager = this._getSessionManager();

      await sessionManager.removeParticipant(req.params.id);

      res.json({ deleted: true });
    });
  }

  // ===========================================================================
  // Agent Routes — /api/v2/agents/
  // ===========================================================================

  handleListAgents() {
    return this._wrap(async (req, res) => {
      let { Agent } = this._getModels();
      let agents    = await Agent.where.organizationID.EQ(req.organizationId).all();

      res.json({ agents });
    });
  }

  handleCreateAgent() {
    return this._wrap(async (req, res) => {
      let { name, pluginID, instructions, apiKey } = req.body || {};

      if (!name)
        return res.status(400).json({ error: 'name is required' });

      if (!pluginID)
        return res.status(400).json({ error: 'pluginID is required' });

      let { Agent } = this._getModels();

      let agentData = {
        organizationID: req.organizationId,
        name,
        pluginID,
        instructions: instructions || null,
      };

      // Encrypt API key if provided
      if (apiKey) {
        let umk     = req.getUMK();
        let userKey = this._keystore.deriveUserKey(umk, req.userId);
        let encrypted = this._keystore.encrypt(apiKey, userKey);

        agentData.encryptedAPIKey = JSON.stringify(encrypted);
      }

      let agent = await Agent.create(agentData);

      res.status(201).json({ agent });
    });
  }

  handleGetAgent() {
    return this._wrap(async (req, res) => {
      let { Agent } = this._getModels();
      let agent     = await Agent.where.id.EQ(req.params.id).first();

      if (!agent)
        return res.status(404).json({ error: 'Agent not found' });

      res.json({ agent });
    });
  }

  handleUpdateAgent() {
    return this._wrap(async (req, res) => {
      let { Agent } = this._getModels();
      let agent     = await Agent.where.id.EQ(req.params.id).first();

      if (!agent)
        return res.status(404).json({ error: 'Agent not found' });

      let { name, pluginID, instructions, apiKey } = req.body || {};

      if (name !== undefined)
        agent.name = name;

      if (pluginID !== undefined)
        agent.pluginID = pluginID;

      if (instructions !== undefined)
        agent.instructions = instructions;

      // Encrypt new API key if provided
      if (apiKey !== undefined) {
        if (apiKey) {
          let umk       = req.getUMK();
          let userKey   = this._keystore.deriveUserKey(umk, req.userId);
          let encrypted = this._keystore.encrypt(apiKey, userKey);

          agent.encryptedAPIKey = JSON.stringify(encrypted);
        } else {
          agent.encryptedAPIKey = null;
        }
      }

      await agent.save();

      res.json({ agent });
    });
  }

  handleDeleteAgent() {
    return this._wrap(async (req, res) => {
      let { Agent } = this._getModels();
      let agent     = await Agent.where.id.EQ(req.params.id).first();

      if (!agent)
        return res.status(404).json({ error: 'Agent not found' });

      await agent.destroy();

      res.json({ deleted: true });
    });
  }

  // ===========================================================================
  // Interaction Routes — /api/v2/sessions/:sessionId/interact/
  // ===========================================================================

  handleSendMessage() {
    return this._wrap(async (req, res) => {
      let { message, agentId } = req.body || {};

      if (!message)
        return res.status(400).json({ error: 'message is required' });

      if (!agentId)
        return res.status(400).json({ error: 'agentId is required' });

      let { Agent }       = this._getModels();
      let interactionLoop = this._getInteractionLoop();

      // Look up agent
      let agent = await Agent.where.id.EQ(agentId).first();
      if (!agent)
        return res.status(404).json({ error: 'Agent not found' });

      // Get agent plugin
      let agentPlugin = this._core.getPlugin(agent.pluginID);
      if (!agentPlugin)
        return res.status(400).json({ error: `No plugin registered for: ${agent.pluginID}` });

      // Resolve API key if encrypted
      let resolvedAgent = { ...agent.toJSON ? agent.toJSON() : agent };
      if (agent.encryptedAPIKey) {
        try {
          let umk       = req.getUMK();
          let userKey   = this._keystore.deriveUserKey(umk, req.userId);
          let encrypted = JSON.parse(agent.encryptedAPIKey);

          resolvedAgent.apiKey = this._keystore.decrypt(encrypted, userKey).toString('utf8');
        } catch (_error) {
          return res.status(400).json({ error: 'Failed to decrypt agent API key' });
        }
      }

      // Start interaction (non-blocking — frames emitted via SSE)
      let interactionID = await interactionLoop.startInteraction(req.params.sessionId, {
        agentPlugin,
        agent:       resolvedAgent,
        userMessage: message,
        authorType:  'user',
        authorID:    req.userId,
      });

      res.status(202).json({ interactionID });
    });
  }

  handleCancelInteraction() {
    return this._wrap(async (req, res) => {
      let interactionLoop = this._getInteractionLoop();
      let queued          = await interactionLoop.cancelInteraction(req.params.sessionId);

      res.json({ cancelled: true, queuedMessages: queued });
    });
  }

  handleApprovePermission() {
    return this._wrap(async (req, res) => {
      let interactionLoop = this._getInteractionLoop();

      let interactionID = await interactionLoop.approvePermission(
        req.params.sessionId,
        req.params.frameId,
      );

      res.json({ approved: true, interactionID });
    });
  }

  handleDenyPermission() {
    return this._wrap(async (req, res) => {
      let interactionLoop = this._getInteractionLoop();

      await interactionLoop.denyPermission(
        req.params.sessionId,
        req.params.frameId,
      );

      res.json({ denied: true });
    });
  }

  // ===========================================================================
  // Frame Routes — /api/v2/sessions/:sessionId/frames/
  // ===========================================================================

  handleListFrames() {
    return this._wrap(async (req, res) => {
      let framePersistence = this._getFramePersistence();
      let frameManager     = await framePersistence.loadFrames(req.params.sessionId, req.query || {});
      let frames           = frameManager.toArray();

      res.json({ frames });
    });
  }

  // ===========================================================================
  // SSE Stream — /api/v2/sessions/:sessionId/stream
  // ===========================================================================

  handleStream() {
    return this._wrap(async (req, res) => {
      let sessionId       = req.params.sessionId;
      let interactionLoop = this._getInteractionLoop();

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send initial ping
      res.write('event: connected\ndata: {}\n\n');

      // Frame listener
      let onFrame = ({ sessionID, frame }) => {
        if (sessionID !== sessionId)
          return;

        res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
      };

      // Interaction lifecycle
      let onInteractionStart = ({ sessionID, interactionID }) => {
        if (sessionID !== sessionId)
          return;

        res.write(`event: interaction:start\ndata: ${JSON.stringify({ interactionID })}\n\n`);
      };

      let onInteractionEnd = ({ sessionID, interactionID }) => {
        if (sessionID !== sessionId)
          return;

        res.write(`event: interaction:end\ndata: ${JSON.stringify({ interactionID })}\n\n`);
      };

      let onPermissionRequest = ({ sessionID, frameID, toolName }) => {
        if (sessionID !== sessionId)
          return;

        res.write(`event: permission:request\ndata: ${JSON.stringify({ frameID, toolName })}\n\n`);
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

      // If the request object supports close event (Node HTTP)
      if (req.on)
        req.on('close', cleanup);

      // Store cleanup reference for testing
      res._sseCleanup = cleanup;
    });
  }

  // ===========================================================================
  // Route Table
  // ===========================================================================

  getRouteTable() {
    return [
      // Auth (unauthenticated)
      { method: 'POST', path: '/api/v2/auth/register', handler: this.handleRegister(), auth: false },
      { method: 'POST', path: '/api/v2/auth/login',    handler: this.handleLogin(),    auth: false },
      { method: 'GET',  path: '/api/v2/auth/me',       handler: this.handleMe(),       auth: true },

      // Sessions
      { method: 'GET',    path: '/api/v2/sessions',              handler: this.handleListSessions(),  auth: true },
      { method: 'POST',   path: '/api/v2/sessions',              handler: this.handleCreateSession(), auth: true },
      { method: 'GET',    path: '/api/v2/sessions/:id',          handler: this.handleGetSession(),    auth: true },
      { method: 'PUT',    path: '/api/v2/sessions/:id',          handler: this.handleUpdateSession(), auth: true },
      { method: 'DELETE', path: '/api/v2/sessions/:id',          handler: this.handleDeleteSession(), auth: true },
      { method: 'POST',   path: '/api/v2/sessions/:id/archive', handler: this.handleArchiveSession(), auth: true },
      { method: 'POST',   path: '/api/v2/sessions/:id/revive',  handler: this.handleReviveSession(),  auth: true },

      // Participants
      { method: 'GET',    path: '/api/v2/sessions/:sessionId/participants',     handler: this.handleListParticipants(),  auth: true },
      { method: 'POST',   path: '/api/v2/sessions/:sessionId/participants',     handler: this.handleAddParticipant(),    auth: true },
      { method: 'DELETE', path: '/api/v2/sessions/:sessionId/participants/:id', handler: this.handleRemoveParticipant(), auth: true },

      // Agents
      { method: 'GET',    path: '/api/v2/agents',     handler: this.handleListAgents(),  auth: true },
      { method: 'POST',   path: '/api/v2/agents',     handler: this.handleCreateAgent(), auth: true },
      { method: 'GET',    path: '/api/v2/agents/:id', handler: this.handleGetAgent(),    auth: true },
      { method: 'PUT',    path: '/api/v2/agents/:id', handler: this.handleUpdateAgent(), auth: true },
      { method: 'DELETE', path: '/api/v2/agents/:id', handler: this.handleDeleteAgent(), auth: true },

      // Interactions
      { method: 'POST', path: '/api/v2/sessions/:sessionId/interact',                  handler: this.handleSendMessage(),       auth: true },
      { method: 'POST', path: '/api/v2/sessions/:sessionId/interact/cancel',           handler: this.handleCancelInteraction(), auth: true },
      { method: 'POST', path: '/api/v2/sessions/:sessionId/interact/approve/:frameId', handler: this.handleApprovePermission(), auth: true },
      { method: 'POST', path: '/api/v2/sessions/:sessionId/interact/deny/:frameId',    handler: this.handleDenyPermission(),    auth: true },

      // Frames
      { method: 'GET', path: '/api/v2/sessions/:sessionId/frames', handler: this.handleListFrames(), auth: true },

      // SSE Stream
      { method: 'GET', path: '/api/v2/sessions/:sessionId/stream', handler: this.handleStream(), auth: true },
    ];
  }
}
