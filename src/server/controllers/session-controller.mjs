'use strict';

// =============================================================================
// SessionController — Session CRUD + archive/revive
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class SessionController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions
  // ---------------------------------------------------------------------------

  async list({ query }) {
    let sessionManager = this.getSessionManager();
    let sessions       = await sessionManager.getSessions(
      this.request.organizationID,
      query || {},
    );

    return { data: { sessions } };
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
}
