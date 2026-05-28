'use strict';

import XID from 'xid-js';
import { FrameManager } from '../../shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Session Manager
// =============================================================================

export class SessionManager {
  /**
   * @param {import('../types').CascadingContext} context
   */
  constructor(context) {
    if (!context)
      throw new Error('SessionManager requires a CascadingContext');

    /** @type {import('../types').CascadingContext} */
    this._context       = context;
    /** @type {Map<string, FrameManager>} */
    this._frameManagers = new Map();
    /** @type {Map<string, string[]>} */
    this._ancestryCache = new Map();

    let models = this._context.getProperty('models');
    if (!models)
      throw new Error('SessionManager requires models on the context');

    /** @type {import('../types').CoreModels} */
    this._models = models;
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  /**
   * @param {string} organizationID
   * @param {object} [options]
   * @param {string} [options.id]
   * @param {string} [options.name]
   * @param {boolean} [options.archived]
   * @param {string} [options.type]
   * @param {string} [options.dmAgentID]
   * @param {string} [options.parentSessionID]
   * @param {string} [options.linkedFrameID]
   * @param {number|null} [options.maxInteractions]
   * @param {Date|null} [options.endsAt]
   * @param {string} [options.agentID]
   * @returns {Promise<import('../types').Session>}
   */
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

    if (options.maxInteractions !== undefined)
      sessionData.maxInteractions = options.maxInteractions;

    if (options.endsAt !== undefined)
      sessionData.endsAt = options.endsAt;

    let session = await Session.create(sessionData);

    // If an agentID was provided, add the agent as a participant
    if (options.agentID) {
      let { Participant } = this._models;
      await Participant.create({
        sessionID: session.id,
        agentID:   options.agentID,
      });
    }

    return session;
  }

  /**
   * @param {string} sessionID
   * @returns {Promise<import('../types').Session|null>}
   */
  async getSession(sessionID) {
    if (!sessionID)
      return null;

    let { Session } = this._models;
    let session     = await Session.where.id.EQ(sessionID).first();
    return session || null;
  }

  /**
   * @param {string} organizationID
   * @param {object} [options]
   * @param {boolean} [options.includeArchived]
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {Promise<import('../types').Session[]>}
   */
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

  /**
   * @param {string} sessionID
   * @param {object} [updates]
   * @param {string} [updates.name]
   * @param {boolean} [updates.archived]
   * @returns {Promise<import('../types').Session>}
   */
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

  /**
   * @param {string} sessionID
   * @returns {Promise<boolean>}
   */
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

  /**
   * @param {string} sessionID
   * @returns {Promise<import('../types').Session>}
   */
  async archiveSession(sessionID) {
    return this.updateSession(sessionID, { archived: true });
  }

  /**
   * @param {string} sessionID
   * @returns {Promise<import('../types').Session>}
   */
  async reviveSession(sessionID) {
    return this.updateSession(sessionID, { archived: false });
  }

  // ---------------------------------------------------------------------------
  // Participant Management
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @param {object} [options]
   * @param {string} [options.role]
   * @returns {Promise<import('../types').Participant>}
   */
  async addParticipant(sessionID, agentID, options = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    if (!agentID)
      throw new Error('agentID is required');

    let session = await this.getSession(sessionID);
    if (!session)
      throw new Error(`Session not found: ${sessionID}`);

    if (session.archived)
      throw new Error('Session is archived');

    let { Agent, Participant } = this._models;
    let agent = await Agent.where.id.EQ(agentID).first();
    if (!agent)
      throw new Error(`Agent not found: ${agentID}`);

    let existing = await Participant.where.sessionID.EQ(sessionID).AND.agentID.EQ(agentID).first();
    if (existing)
      return existing;

    let role        = options.role || 'member';
    let participant = await Participant.create({ sessionID, agentID, role });

    let frameManager = this.getFrameManager(sessionID);
    let agentName    = agent.name || agentID;
    let frameData = {
      id:         `frm_${XID.next()}`,
      type:       'Message',
      content:    { html: `<p><em>${agentName} has joined the session.</em></p>` },
      timestamp:  Date.now(),
      authorType: 'system',
      authorID:   null,
      hidden:     false,
      deleted:    false,
      processed:  false,
    };

    frameManager.merge([frameData], { authorType: 'system' });

    let framePersistence = this._context.getProperty('framePersistence');
    if (framePersistence)
      await framePersistence.saveFrames(sessionID, [frameData]);

    return participant;
  }

  /**
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {Promise<boolean|null>}
   */
  async removeParticipant(sessionID, agentID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    if (!agentID)
      throw new Error('agentID is required');

    let { Agent, Participant } = this._models;
    let participant = await Participant.where.sessionID.EQ(sessionID).AND.agentID.EQ(agentID).first();

    if (!participant)
      return null;

    let agent     = await Agent.where.id.EQ(agentID).first();
    let agentName = agent ? agent.name : agentID;

    await participant.destroy();

    let frameManager = this.getFrameManager(sessionID);
    let frameData = {
      id:         `frm_${XID.next()}`,
      type:       'ParticipantLeft',
      content:    { agentID, agentName, reason: 'removed' },
      timestamp:  Date.now(),
      authorType: 'system',
      authorID:   null,
      hidden:     false,
      deleted:    false,
      processed:  false,
    };

    frameManager.merge([frameData], { authorType: 'system' });

    let framePersistence = this._context.getProperty('framePersistence');
    if (framePersistence)
      await framePersistence.saveFrames(sessionID, [frameData]);

    return true;
  }

  /**
   * @param {string} sessionID
   * @returns {Promise<import('../types').Participant[]>}
   */
  async getParticipants(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Participant } = this._models;
    let participants    = await Participant.where.sessionID.EQ(sessionID).all();
    return participants;
  }

  /**
   * @param {string} participantID
   * @param {object} [updates]
   * @param {string} [updates.role]
   * @returns {Promise<import('../types').Participant>}
   */
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

  /**
   * @param {string} sessionID
   * @returns {Promise<import('../types').Participant[]>}
   */
  async getCoordinators(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Participant } = this._models;
    let participants    = await Participant.where.sessionID.EQ(sessionID).AND.role.EQ('coordinator').all();
    return participants;
  }

  // ---------------------------------------------------------------------------
  // Ancestry Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns an array of session IDs from self to root:
   *   [sessionID, parentID, grandparentID, ...]
   *
   * Returns an empty array if the session does not exist.
   * Results are cached — ancestry is immutable once a session is created.
   * @param {string} sessionID
   * @returns {Promise<string[]>}
   */
  async getAncestryChain(sessionID) {
    if (!sessionID)
      return [];

    // Check cache first
    let cached = this._ancestryCache.get(sessionID);
    if (cached)
      return cached;

    let chain      = [];
    let currentID  = sessionID;
    let visited    = new Set();
    let maxDepth   = 100;

    while (currentID && chain.length < maxDepth) {
      if (visited.has(currentID))
        break;

      let session = await this.getSession(currentID);
      if (!session)
        break;

      chain.push(currentID);
      visited.add(currentID);
      currentID = session.parentSessionID || null;
    }

    if (chain.length > 0)
      this._ancestryCache.set(sessionID, chain);

    return chain;
  }

  /**
   * Returns the session ID of the closest ancestor (including self) that has
   * at least one frame with authorType === 'user'.
   *
   * Returns null if no user found in any ancestor or if session doesn't exist.
   * @param {string} sessionID
   * @returns {Promise<string|null>}
   */
  async getNearestUserAncestor(sessionID) {
    if (!sessionID)
      return null;

    let chain = await this.getAncestryChain(sessionID);
    if (chain.length === 0)
      return null;

    let { Frame } = this._models;

    for (let ancestorID of chain) {
      let userFrame = await Frame.where
        .sessionID.EQ(ancestorID)
        .AND.authorType.EQ('user')
        .first();

      if (userFrame)
        return ancestorID;
    }

    return null;
  }

  /**
   * Clears the ancestry cache entry for a session.
   * Also clears any cached chains that include this sessionID.
   * @param {string} sessionID
   * @returns {void}
   */
  clearAncestryCache(sessionID) {
    if (!sessionID)
      return;

    this._ancestryCache.delete(sessionID);

    for (let [cachedSessionID, chain] of this._ancestryCache) {
      if (chain.includes(sessionID))
        this._ancestryCache.delete(cachedSessionID);
    }
  }

  // ---------------------------------------------------------------------------
  // FrameManager Integration
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @param {object} [options]
   * @param {Function} [options.commitValidator]
   * @returns {FrameManager}
   */
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

    let frameRouter = this._context.getProperty('frameRouter');
    if (frameRouter)
      frameRouter.connectTo(frameManager, { id: sessionID });

    this._frameManagers.set(sessionID, frameManager);
    return frameManager;
  }

  /**
   * @param {string} sessionID
   * @returns {boolean}
   */
  destroyFrameManager(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let existed = this._frameManagers.delete(sessionID);
    return existed;
  }
}
