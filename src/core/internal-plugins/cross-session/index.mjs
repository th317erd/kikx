'use strict';

import XID from 'xid-js';
import { CrossSessionPermissions } from './cross-session-permissions.mjs';

// =============================================================================
// Cross-Session Plugin
// =============================================================================
// Provides tools for cross-session operations: listing, creating, posting to,
// reading from, and inviting participants to sessions.
//
// Tools registered:
//   cross-session:listSessions
//   cross-session:createSession
//   cross-session:postToSession
//   cross-session:readFromSession
//   cross-session:inviteParticipant
// =============================================================================

export function setup({ registerTool, PluginInterface }) {

  // ---------------------------------------------------------------------------
  // cross-session:listSessions
  // ---------------------------------------------------------------------------

  class ListSessionsTool extends PluginInterface {
    static pluginID    = 'cross-session';
    static featureName = 'listSessions';
    static displayName = 'List Sessions';
    static description = 'List sessions the agent has access to';
    static riskLevel   = 'low';
    static inputSchema = {
      type:       'object',
      properties: {
        search:          { type: 'string', description: 'Keyword filter on session name' },
        type:            { type: 'string', enum: ['chat', 'dm'] },
        archived:        { type: 'boolean', default: false },
        parentSessionID: { type: 'string', description: 'Filter by parent session' },
        topLevelOnly:    { type: 'boolean', default: false },
        limit:           { type: 'integer', default: 20 },
        offset:          { type: 'integer', default: 0 },
      },
    };

    getHelp() {
      return {
        ...super.getHelp(),
        usage:    'cross-session:listSessions { search: "keyword" }',
        examples: [
          { description: 'List all accessible sessions' },
          { search: 'planning', description: 'Filter sessions by name' },
          { type: 'dm', description: 'List only DM sessions' },
          { parentSessionID: 'ses_abc', description: 'List sub-sessions of a parent' },
        ],
      };
    }

    getPermissionsClass() {
      return CrossSessionPermissions;
    }

    async _execute(params) {
      let models  = this._context.getProperty('models');
      let { Participant, Session } = models;
      let agentID = params.agentID;

      // Get session IDs where agent is participant
      let participantRecords = await Participant.where.agentID.EQ(agentID).all();
      let sessionIDs = participantRecords.map((p) => p.sessionID);

      if (sessionIDs.length === 0)
        return { sessions: [] };

      // Load sessions and apply filters
      let sessions = [];
      for (let sessionID of sessionIDs) {
        let session = await Session.where.id.EQ(sessionID).first();
        if (!session)
          continue;

        // Type filter
        if (params.type && session.type !== params.type)
          continue;

        // Archived filter
        if (params.archived === true && !session.archived)
          continue;

        if (!params.archived && session.archived)
          continue;

        // Parent session filter
        if (params.parentSessionID && session.parentSessionID !== params.parentSessionID)
          continue;

        // Top-level only filter
        if (params.topLevelOnly && session.parentSessionID != null)
          continue;

        // Search filter (case-insensitive name match, then frame content)
        if (params.search) {
          let searchLower = params.search.toLowerCase();
          let nameMatch = session.name && session.name.toLowerCase().includes(searchLower);
          if (!nameMatch) {
            // Fall back to searching frame content in-memory
            let sessionManager = this._context.getProperty('sessionManager');
            let fm = sessionManager.getFrameManager(session.id);
            let frames = fm.toArray();
            let contentMatch = frames.some((f) => {
              let contentString = (typeof f.content === 'string') ? f.content : JSON.stringify(f.content || '');
              return contentString.toLowerCase().includes(searchLower);
            });
            if (!contentMatch)
              continue;
          }
        }

        // Get participant count for this session
        let sessionParticipants = await Participant.where.sessionID.EQ(session.id).all();

        let createdAt      = session.createdAt;
        let updatedAt      = session.updatedAt;
        let createdMs      = (createdAt && typeof createdAt.toMillis === 'function') ? createdAt.toMillis() : createdAt;
        let updatedMs      = (updatedAt && typeof updatedAt.toMillis === 'function') ? updatedAt.toMillis() : updatedAt;
        let lastActivityAt = (!updatedAt || updatedMs === createdMs) ? createdAt : updatedAt;

        sessions.push({
          id:               session.id,
          name:             session.name,
          type:             session.type,
          archived:         session.archived,
          parentSessionID:  session.parentSessionID,
          participantCount: sessionParticipants.length,
          createdAt,
          lastActivityAt,
        });
      }

      // Pagination
      let offset = params.offset || 0;
      let limit  = params.limit || 20;
      sessions = sessions.slice(offset, offset + limit);

      return { sessions };
    }
  }

  // ---------------------------------------------------------------------------
  // cross-session:createSession
  // ---------------------------------------------------------------------------

  class CreateSessionTool extends PluginInterface {
    static pluginID    = 'cross-session';
    static featureName = 'createSession';
    static displayName = 'Create Session';
    static description = 'Create a top-level or sub-session';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['title'],
      properties: {
        title:           { type: 'string' },
        participants:    { type: 'array', items: { type: 'string' }, default: [] },
        parentSessionID: { type: 'string' },
        type:            { type: 'string', default: 'chat' },
        initialMessage:  { type: 'string', description: 'First message in the new session, authored by the creating agent' },
        constraints:     {
          type:        'object',
          description: 'Session constraints (maxInteractions, endsAt)',
          properties:  {
            maxInteractions: { type: 'integer', description: 'Maximum number of agent interactions' },
            endsAt:          { type: 'string', description: 'ISO 8601 timestamp after which the session auto-archives' },
          },
        },
      },
    };

    // Default maxInteractions for agent-created child sessions
    static DEFAULT_CHILD_MAX_INTERACTIONS = 20;

    getHelp() {
      return {
        ...super.getHelp(),
        usage:    'cross-session:createSession { title: "Session Name" }',
        examples: [
          { title: 'Research', description: 'Create a new top-level session' },
          { title: 'Sub-task', parentSessionID: 'ses_abc', description: 'Create a sub-session' },
          { title: 'Collab', participants: ['agent-name'], initialMessage: 'Hello!', description: 'Create a session with participants and an initial message' },
        ],
      };
    }

    async _execute(params) {
      let sessionManager = this._context.getProperty('sessionManager');
      let models         = this._context.getProperty('models');
      let { Agent }      = models;

      if (!params.title)
        throw new Error('title is required');

      let agentID        = params.agentID;
      let organizationID = null;

      // Resolve organization from the agent
      if (agentID) {
        let agent = await Agent.where.id.EQ(agentID).first();
        if (agent)
          organizationID = agent.organizationID;
      }

      let sessionOptions = { name: params.title, type: params.type || 'chat' };

      // Apply constraints if provided
      let constraints = params.constraints || {};
      if (constraints.maxInteractions !== undefined)
        sessionOptions.maxInteractions = constraints.maxInteractions;

      if (constraints.endsAt !== undefined)
        sessionOptions.endsAt = constraints.endsAt;

      // Sub-session handling
      if (params.parentSessionID) {
        let parentSession = await sessionManager.getSession(params.parentSessionID);
        if (!parentSession)
          throw new Error(`Parent session not found: ${params.parentSessionID}`);

        if (parentSession.archived)
          throw new Error('Parent session is archived');

        organizationID = organizationID || parentSession.organizationID;
        sessionOptions.parentSessionID = params.parentSessionID;

        // Apply default constraints for agent-created child sessions (if no explicit constraints)
        if (agentID && sessionOptions.maxInteractions === undefined)
          sessionOptions.maxInteractions = CreateSessionTool.DEFAULT_CHILD_MAX_INTERACTIONS;

        // Pre-generate a frame ID for the session-link
        let frameID = `frm_${XID.next()}`;
        sessionOptions.linkedFrameID = frameID;

        // Create the sub-session
        let session = await sessionManager.createSession(organizationID, sessionOptions);

        // Create session-link frame in parent session
        let frameManager = sessionManager.getFrameManager(params.parentSessionID);
        let linkFrame = {
          id:         frameID,
          type:       'session-link',
          content:    { targetSessionID: session.id, title: params.title, participants: params.participants || [] },
          timestamp:  Date.now(),
          authorType: 'system',
          authorID:   null,
          hidden:     false,
          deleted:    false,
          processed:  false,
        };
        frameManager.merge([linkFrame], { authorType: 'system' });

        let framePersistence = this._context.getProperty('framePersistence');
        if (framePersistence)
          await framePersistence.saveFrames(params.parentSessionID, [linkFrame]);

        // Add participants (creating agent → coordinator, others → member)
        await this._addParticipants(sessionManager, models, session.id, params.participants || [], agentID);

        // Create initial message frame if provided
        await this._createInitialMessage(session.id, params.initialMessage, agentID);

        return { sessionID: session.id, title: params.title, participants: params.participants || [] };
      }

      // Top-level session
      let session = await sessionManager.createSession(organizationID, sessionOptions);
      await this._addParticipants(sessionManager, models, session.id, params.participants || [], agentID);

      // Create initial message frame if provided
      await this._createInitialMessage(session.id, params.initialMessage, agentID);

      return { sessionID: session.id, title: params.title, participants: params.participants || [] };
    }

    async _addParticipants(sessionManager, models, sessionID, participantNames, creatorAgentID) {
      let { Agent } = models;
      for (let name of participantNames) {
        let agent = await Agent.where.name.EQ(name).first();
        if (!agent)
          throw new Error(`Agent not found: ${name}`);

        // Creating agent gets coordinator role, others get member
        let role = (creatorAgentID && agent.id === creatorAgentID) ? 'coordinator' : 'member';
        await sessionManager.addParticipant(sessionID, agent.id, { role });
      }
    }

    async _createInitialMessage(sessionID, initialMessage, agentID) {
      if (!initialMessage)
        return;

      let sessionManager  = this._context.getProperty('sessionManager');
      let framePersistence = this._context.getProperty('framePersistence');

      let frameManager = sessionManager.getFrameManager(sessionID);
      let frameData    = {
        id:         `frm_${XID.next()}`,
        type:       'message',
        content:    { text: initialMessage },
        timestamp:  Date.now(),
        authorType: 'agent',
        authorID:   agentID || null,
        hidden:     false,
        deleted:    false,
        processed:  false,
      };

      frameManager.merge([frameData], { authorType: 'agent', authorID: agentID || null });

      if (framePersistence)
        await framePersistence.saveFrames(sessionID, [frameData]);
    }

    getPermissionsClass() {
      return CrossSessionPermissions;
    }
  }

  // ---------------------------------------------------------------------------
  // cross-session:postToSession
  // ---------------------------------------------------------------------------

  class PostToSessionTool extends PluginInterface {
    static pluginID    = 'cross-session';
    static featureName = 'postToSession';
    static displayName = 'Post to Session';
    static description = 'Post a message to another session';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['sessionID', 'message'],
      properties: {
        sessionID: { type: 'string' },
        message:   { type: 'string' },
      },
    };

    getHelp() {
      return {
        ...super.getHelp(),
        usage:    'cross-session:postToSession { sessionID: "ses_...", message: "Hello" }',
        examples: [
          { sessionID: 'ses_abc', message: 'Update from the main session', description: 'Post a message to another session' },
        ],
      };
    }

    async _execute(params) {
      if (!params.sessionID)
        throw new Error('sessionID is required');

      if (!params.message)
        throw new Error('message is required');

      let sessionManager = this._context.getProperty('sessionManager');
      let session = await sessionManager.getSession(params.sessionID);
      if (!session)
        throw new Error(`Session not found: ${params.sessionID}`);

      if (session.archived)
        throw new Error('Session is archived');

      let agentID = params.agentID;
      let frameID = `frm_${XID.next()}`;

      // Set up streaming relay from current session to target session
      let streamRelay      = this._context.getProperty('streamRelay');
      let currentSessionID = params.currentSessionID || null;

      if (streamRelay && currentSessionID && currentSessionID !== params.sessionID)
        streamRelay.createRelay(currentSessionID, params.sessionID);

      let frameManager = sessionManager.getFrameManager(params.sessionID);
      let frameData = {
        id:         frameID,
        type:       'message',
        content:    { text: params.message },
        timestamp:  Date.now(),
        authorType: 'agent',
        authorID:   agentID,
        hidden:     false,
        deleted:    false,
        processed:  false,
      };
      frameManager.merge([frameData], { authorType: 'agent', authorID: agentID });

      let framePersistence = this._context.getProperty('framePersistence');
      if (framePersistence)
        await framePersistence.saveFrames(params.sessionID, [frameData]);

      return { frameID, sessionID: params.sessionID };
    }

    getPermissionsClass() {
      return CrossSessionPermissions;
    }
  }

  // ---------------------------------------------------------------------------
  // cross-session:readFromSession
  // ---------------------------------------------------------------------------

  class ReadFromSessionTool extends PluginInterface {
    static pluginID    = 'cross-session';
    static featureName = 'readFromSession';
    static displayName = 'Read from Session';
    static description = 'Read frames from another session with filtering';
    static riskLevel   = 'low';
    static inputSchema = {
      type:       'object',
      required:   ['sessionID'],
      properties: {
        sessionID: { type: 'string' },
        keyword:   { type: 'string' },
        types:     { type: 'array', items: { type: 'string' } },
        limit:     { type: 'integer', default: 10 },
        offset:    { type: 'integer', default: 0 },
      },
    };

    getHelp() {
      return {
        ...super.getHelp(),
        usage:    'cross-session:readFromSession { sessionID: "ses_..." }',
        examples: [
          { sessionID: 'ses_abc', description: 'Read recent frames from a session' },
          { sessionID: 'ses_abc', keyword: 'decision', description: 'Search for frames containing a keyword' },
          { sessionID: 'ses_abc', types: ['message'], limit: 5, description: 'Read only message frames with a limit' },
        ],
      };
    }

    async _execute(params) {
      if (!params.sessionID)
        throw new Error('sessionID is required');

      let sessionManager = this._context.getProperty('sessionManager');
      let session = await sessionManager.getSession(params.sessionID);
      if (!session)
        throw new Error(`Session not found: ${params.sessionID}`);

      let frameManager = sessionManager.getFrameManager(params.sessionID);
      let frames = frameManager.toArray();

      // Type filter
      if (params.types && params.types.length > 0) {
        frames = frames.filter((f) => params.types.includes(f.type));
      } else {
        // Exclude system lifecycle frames by default
        frames = frames.filter((f) => f.authorType !== 'system');
      }

      // Keyword filter (case-insensitive search in content)
      if (params.keyword) {
        let keyword = params.keyword.toLowerCase();
        frames = frames.filter((f) => {
          let contentString = (typeof f.content === 'string') ? f.content : JSON.stringify(f.content || '');
          return contentString.toLowerCase().includes(keyword);
        });
      }

      // Pagination
      let offset = params.offset || 0;
      let limit  = Math.min(params.limit || 10, 50);
      frames = frames.slice(offset, offset + limit);

      // Build summaries
      let summaries = frames.map((f) => {
        let contentString = (typeof f.content === 'string') ? f.content : JSON.stringify(f.content || '');
        let snippet = (contentString.length > 200) ? contentString.slice(0, 200) + '...' : contentString;
        return {
          id:         f.id,
          type:       f.type,
          authorType: f.authorType,
          authorID:   f.authorID,
          content:    snippet,
          timestamp:  f.timestamp,
        };
      });

      return { frames: summaries };
    }
  }

  // ---------------------------------------------------------------------------
  // cross-session:inviteParticipant
  // ---------------------------------------------------------------------------

  class InviteParticipantTool extends PluginInterface {
    static pluginID    = 'cross-session';
    static featureName = 'inviteParticipant';
    static displayName = 'Invite Participant';
    static description = 'Invite an agent to a session';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['sessionID', 'agentName'],
      properties: {
        sessionID: { type: 'string' },
        agentName: { type: 'string' },
      },
    };

    getHelp() {
      return {
        ...super.getHelp(),
        usage:    'cross-session:inviteParticipant { sessionID: "ses_...", agentName: "agent-name" }',
        examples: [
          { sessionID: 'ses_abc', agentName: 'test-claude', description: 'Invite an agent to participate in a session' },
        ],
      };
    }

    async _execute(params) {
      if (!params.sessionID)
        throw new Error('sessionID is required');

      if (!params.agentName)
        throw new Error('agentName is required');

      let sessionManager = this._context.getProperty('sessionManager');
      let models         = this._context.getProperty('models');
      let { Agent }      = models;

      let session = await sessionManager.getSession(params.sessionID);
      if (!session)
        throw new Error(`Session not found: ${params.sessionID}`);

      if (session.archived)
        throw new Error('Session is archived');

      let agent = await Agent.where.name.EQ(params.agentName).first();
      if (!agent)
        throw new Error(`Agent not found: ${params.agentName}`);

      // Reject self-invite
      let callerAgentID = params.agentID;
      if (callerAgentID && agent.id === callerAgentID)
        throw new Error('Cannot invite yourself');

      let participant = await sessionManager.addParticipant(params.sessionID, agent.id);

      return {
        participantID: participant.id,
        agentID:       agent.id,
        agentName:     agent.name,
        sessionID:     params.sessionID,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Register all tools
  // ---------------------------------------------------------------------------

  registerTool('cross-session:listSessions',     ListSessionsTool);
  registerTool('cross-session:createSession',     CreateSessionTool);
  registerTool('cross-session:postToSession',     PostToSessionTool);
  registerTool('cross-session:readFromSession',   ReadFromSessionTool);
  registerTool('cross-session:inviteParticipant', InviteParticipantTool);

  return () => {};
}
