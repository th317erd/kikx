'use strict';

// =============================================================================
// ParticipantController — Participant list/add/remove
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class ParticipantController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions/:sessionId/participants
  // ---------------------------------------------------------------------------

  async list({ params }) {
    let sessionManager = this.getSessionManager();
    let participants   = await sessionManager.getParticipants(params.sessionId);

    return { data: { participants } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/participants
  // ---------------------------------------------------------------------------

  async create({ params, body }) {
    let { agentId } = body || {};

    if (!agentId)
      this.throwBadRequestError('agentId is required');

    let sessionManager = this.getSessionManager();
    let participant    = await sessionManager.addParticipant(params.sessionId, agentId);

    this.setStatusCode(201);

    return { data: { participant } };
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/v2/sessions/:sessionId/participants/:id
  // ---------------------------------------------------------------------------

  async destroy({ params }) {
    let sessionManager = this.getSessionManager();
    let models         = this.getCoreModels();
    let { Participant } = models;

    // Look up participant to get sessionID and agentID for the new signature
    let participant = await Participant.where.id.EQ(params.participantId).first();
    if (!participant)
      this.throwNotFoundError('Participant not found');

    await sessionManager.removeParticipant(participant.sessionID, participant.agentID);

    return { data: { deleted: true } };
  }
}
