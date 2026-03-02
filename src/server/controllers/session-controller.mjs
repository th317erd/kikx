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
      this.request.organizationId,
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
      this.request.organizationId,
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
    let session        = await sessionManager.getSession(params.sessionId);

    if (!session)
      this.throwNotFoundError('Session not found');

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // PUT /api/v2/sessions/:id
  // ---------------------------------------------------------------------------

  async update({ params, body }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.updateSession(params.sessionId, body || {});

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/v2/sessions/:id
  // ---------------------------------------------------------------------------

  async destroy({ params }) {
    let sessionManager = this.getSessionManager();

    await sessionManager.deleteSession(params.sessionId);

    return { data: { deleted: true } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:id/archive
  // ---------------------------------------------------------------------------

  async archive({ params }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.archiveSession(params.sessionId);

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:id/revive
  // ---------------------------------------------------------------------------

  async revive({ params }) {
    let sessionManager = this.getSessionManager();
    let session        = await sessionManager.reviveSession(params.sessionId);

    return { data: { session } };
  }
}
