'use strict';

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

    if (options.name !== undefined)
      sessionData.name = options.name;

    if (options.archived !== undefined)
      sessionData.archived = options.archived;

    if (options.type !== undefined)
      sessionData.type = options.type;

    if (options.dmAgentID !== undefined)
      sessionData.dmAgentID = options.dmAgentID;

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

    // Validate agent exists
    let { Agent, Participant } = this._models;
    let agent = await Agent.where.id.EQ(agentID).first();
    if (!agent)
      throw new Error(`Agent not found: ${agentID}`);

    let participantData = {
      sessionID,
      agentID,
    };

    if (options.alias !== undefined)
      participantData.alias = options.alias;

    if (options.overrides !== undefined)
      participantData.overrides = (typeof options.overrides === 'string')
        ? options.overrides
        : JSON.stringify(options.overrides);

    let participant = await Participant.create(participantData);
    return participant;
  }

  async removeParticipant(participantID) {
    if (!participantID)
      throw new Error('participantID is required');

    let { Participant } = this._models;
    let participant     = await Participant.where.id.EQ(participantID).first();

    if (!participant)
      throw new Error(`Participant not found: ${participantID}`);

    await participant.destroy();
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

    if (updates.alias !== undefined)
      participant.alias = updates.alias;

    if (updates.overrides !== undefined) {
      participant.overrides = (typeof updates.overrides === 'string')
        ? updates.overrides
        : JSON.stringify(updates.overrides);
    }

    await participant.save();
    return participant;
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
