'use strict';

import XID from 'xid-js';
import { FrameManager } from '../../shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Session Manager
// =============================================================================
// CRUD for sessions, participant binding, and FrameManager instances per session.
// Models are obtained from context (never imported directly).
// =============================================================================

export class SessionManager {
  constructor(context) {
    if (!context)
      throw new Error('SessionManager requires a CascadingContext');

    this._context       = context;
    this._frameManagers = new Map();

    let models = this._context.getProperty('models');
    if (!models)
      throw new Error('SessionManager requires models on the context');

    this._models = models;
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  async createSession(organizationID, options = {}) {
    if (!organizationID)
      throw new Error('organizationID is required');

    let { Session } = this._models;
    let sessionData = { organizationID };

    if (options.id !== undefined)
      sessionData.id = options.id;

    if (options.name !== undefined)
      sessionData.name = options.name;

    if (options.archived !== undefined)
      sessionData.archived = options.archived;

    if (options.type !== undefined)
      sessionData.type = options.type;

    if (options.dmAgentID !== undefined)
      sessionData.dmAgentID = options.dmAgentID;

    if (options.parentSessionID !== undefined)
      sessionData.parentSessionID = options.parentSessionID;

    if (options.parentSessionID !== undefined && options.id !== undefined && options.parentSessionID === options.id)
      throw new Error('Session cannot be its own parent');

    if (options.linkedFrameID !== undefined)
      sessionData.linkedFrameID = options.linkedFrameID;

    let session = await Session.create(sessionData);
    return session;
  }

  async getSession(sessionID) {
    if (!sessionID)
      return null;

    let { Session } = this._models;
    let session     = await Session.where.id.EQ(sessionID).first();
    return session || null;
  }

  async getSessions(organizationID, options = {}) {
    if (!organizationID)
      throw new Error('organizationID is required');

    let { Session }      = this._models;
    let includeArchived  = options.includeArchived === true;
    let limit            = options.limit;
    let offset           = options.offset;

    let query = Session.where.organizationID.EQ(organizationID);

    if (!includeArchived)
      query = query.AND.archived.EQ(false);

    if (limit !== undefined)
      query = query.LIMIT(limit);

    if (offset !== undefined)
      query = query.OFFSET(offset);

    let sessions = await query.all();
    return sessions;
  }

  async updateSession(sessionID, updates = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let session = await this.getSession(sessionID);
    if (!session)
      throw new Error(`Session not found: ${sessionID}`);

    if (updates.name !== undefined)
      session.name = updates.name;

    if (updates.archived !== undefined)
      session.archived = updates.archived;

    await session.save();
    return session;
  }

  async deleteSession(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let session = await this.getSession(sessionID);
    if (!session)
      throw new Error(`Session not found: ${sessionID}`);

    // Clean up cached FrameManager if one exists
    this._frameManagers.delete(sessionID);

    await session.destroy();
    return true;
  }

  async archiveSession(sessionID) {
    return this.updateSession(sessionID, { archived: true });
  }

  async reviveSession(sessionID) {
    return this.updateSession(sessionID, { archived: false });
  }

  // ---------------------------------------------------------------------------
  // Participant Management
  // ---------------------------------------------------------------------------

  async addParticipant(sessionID, agentID, options = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    if (!agentID)
      throw new Error('agentID is required');

    // Validate session exists
    let session = await this.getSession(sessionID);
    if (!session)
      throw new Error(`Session not found: ${sessionID}`);

    // Reject if archived
    if (session.archived)
      throw new Error('Session is archived');

    // Validate agent exists
    let { Agent, Participant } = this._models;
    let agent = await Agent.where.id.EQ(agentID).first();
    if (!agent)
      throw new Error(`Agent not found: ${agentID}`);

    // Idempotent: if already a participant, return existing
    let existing = await Participant.where.sessionID.EQ(sessionID).AND.agentID.EQ(agentID).first();
    if (existing)
      return existing;

    // Create Participant record with optional role
    let role        = options.role || 'member';
    let participant = await Participant.create({ sessionID, agentID, role });

    // Create participant-joined frame
    let frameManager = this.getFrameManager(sessionID);
    let frameData = {
      id:         `frm_${XID.next()}`,
      type:       'participant-joined',
      content:    { agentID, agentName: agent.name },
      timestamp:  Date.now(),
      authorType: 'system',
      authorID:   null,
      hidden:     false,
      deleted:    false,
      processed:  false,
    };

    frameManager.merge([frameData], { authorType: 'system' });

    // Persist the frame
    let framePersistence = this._context.getProperty('framePersistence');
    if (framePersistence)
      await framePersistence.saveFrames(sessionID, [frameData]);

    return participant;
  }

  async removeParticipant(sessionID, agentID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    if (!agentID)
      throw new Error('agentID is required');

    // Find the participant
    let { Agent, Participant } = this._models;
    let participant = await Participant.where.sessionID.EQ(sessionID).AND.agentID.EQ(agentID).first();

    // No-op if not a participant (return falsy)
    if (!participant)
      return null;

    // Look up agent name for the frame
    let agent     = await Agent.where.id.EQ(agentID).first();
    let agentName = agent ? agent.name : agentID;

    // Delete the participant record
    await participant.destroy();

    // Create participant-left frame
    let frameManager = this.getFrameManager(sessionID);
    let frameData = {
      id:         `frm_${XID.next()}`,
      type:       'participant-left',
      content:    { agentID, agentName, reason: 'removed' },
      timestamp:  Date.now(),
      authorType: 'system',
      authorID:   null,
      hidden:     false,
      deleted:    false,
      processed:  false,
    };

    frameManager.merge([frameData], { authorType: 'system' });

    // Persist the frame
    let framePersistence = this._context.getProperty('framePersistence');
    if (framePersistence)
      await framePersistence.saveFrames(sessionID, [frameData]);

    return true;
  }

  async getParticipants(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Participant } = this._models;
    let participants    = await Participant.where.sessionID.EQ(sessionID).all();
    return participants;
  }

  async updateParticipant(participantID, updates = {}) {
    if (!participantID)
      throw new Error('participantID is required');

    let { Participant } = this._models;
    let participant     = await Participant.where.id.EQ(participantID).first();

    if (!participant)
      throw new Error(`Participant not found: ${participantID}`);

    if (updates.role !== undefined)
      participant.role = updates.role;

    await participant.save();
    return participant;
  }

  async getCoordinators(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Participant } = this._models;
    let participants    = await Participant.where.sessionID.EQ(sessionID).AND.role.EQ('coordinator').all();
    return participants;
  }

  // ---------------------------------------------------------------------------
  // FrameManager Integration
  // ---------------------------------------------------------------------------

  getFrameManager(sessionID, options = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let frameManager = this._frameManagers.get(sessionID);
    if (frameManager)
      return frameManager;

    let managerOptions = { history: true };

    if (options.commitValidator)
      managerOptions.commitValidator = options.commitValidator;

    frameManager = new FrameManager(managerOptions);

    // Auto-connect FrameRouter if available on context
    let frameRouter = this._context.getProperty('frameRouter');
    if (frameRouter)
      frameRouter.connectTo(frameManager, { id: sessionID });

    this._frameManagers.set(sessionID, frameManager);
    return frameManager;
  }

  destroyFrameManager(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let existed = this._frameManagers.delete(sessionID);
    return existed;
  }
}
