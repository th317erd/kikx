'use strict';

// =============================================================================
// SessionController — Session CRUD + archive/revive + unread enrichment
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class SessionController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions
  // ---------------------------------------------------------------------------

  async list({ query }) {
    let sessionManager    = this.getSessionManager();
    let framePersistence  = this.getFramePersistence();
    let valueStore        = this.getValueStoreService();
    let userID            = this.request.userID;
    let organizationID    = this.request.organizationID;
    let { Participant }   = this.getCoreModels();

    let sessions = await sessionManager.getSessions(organizationID, query || {});

    let enriched = [];

    for (let session of sessions) {
      let sessionData = session.toJSON ? session.toJSON() : { ...session };

      // Participant count
      let participants = await Participant.where.sessionID.EQ(session.id).all();
      sessionData.participantCount = participants.length;

      // Last activity
      let createdAt = session.createdAt;
      let updatedAt = session.updatedAt;
      let createdMs = (createdAt && typeof createdAt.toMillis === 'function') ? createdAt.toMillis() : createdAt;
      let updatedMs = (updatedAt && typeof updatedAt.toMillis === 'function') ? updatedAt.toMillis() : updatedAt;

      sessionData.lastActivity = (!updatedAt || updatedMs === createdMs) ? createdAt : updatedAt;

      // Unread count: max frame order minus user's last read position
      let maxOrder     = await framePersistence.getMaxOrder(session.id);
      let lastReadOrder = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });

      // Default unreadCount=0 for unseen sessions (no read position stored yet)
      if (lastReadOrder == null)
        sessionData.unreadCount = 0;
      else
        sessionData.unreadCount = Math.max(0, maxOrder - lastReadOrder);

      enriched.push(sessionData);
    }

    return { data: { sessions: enriched } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions
  // ---------------------------------------------------------------------------

  async create({ body }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.createSession(
      this.request.organizationID,
      body || {},
    );

    this.setStatusCode(201);

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions/:id
  // ---------------------------------------------------------------------------

  async show({ params }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.getSession(params.sessionID);

    if (!session)
      this.throwNotFoundError('Session not found');

    let participants = await sessionManager.getParticipants(params.sessionID);
    let sessionData  = session.toJSON ? session.toJSON() : { ...session };

    sessionData.participants = participants.map((p) => p.toJSON ? p.toJSON() : { ...p });

    return { data: { session: sessionData } };
  }

  // ---------------------------------------------------------------------------
  // PUT /api/v2/sessions/:id
  // ---------------------------------------------------------------------------

  async update({ params, body }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.updateSession(params.sessionID, body || {});

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/v2/sessions/:id
  // ---------------------------------------------------------------------------

  async destroy({ params }) {
    let sessionManager = this.getSessionManager();

    await sessionManager.deleteSession(params.sessionID);

    return { data: { deleted: true } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:id/archive
  // ---------------------------------------------------------------------------

  async archive({ params }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.archiveSession(params.sessionID);

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:id/revive
  // ---------------------------------------------------------------------------

  async revive({ params }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.reviveSession(params.sessionID);

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:id/read
  // ---------------------------------------------------------------------------

  async markRead({ params }) {
    let sessionManager   = this.getSessionManager();
    let framePersistence = this.getFramePersistence();
    let valueStore       = this.getValueStoreService();
    let userID           = this.request.userID;
    let organizationID   = this.request.organizationID;

    let session = await sessionManager.getSession(params.sessionID);
    if (!session)
      this.throwNotFoundError('Session not found');

    let maxOrder = await framePersistence.getMaxOrder(params.sessionID);

    await valueStore.set('user', userID, 'read-state', 'lastReadOrder', maxOrder, {
      scopeID:        params.sessionID,
      organizationID,
    });

    return { data: { lastReadOrder: maxOrder } };
  }
}
