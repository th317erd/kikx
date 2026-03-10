'use strict';

// =============================================================================
// ParticipantController — Participant list/add/remove
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class ParticipantController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions/:sessionID/participants
  // ---------------------------------------------------------------------------

  async list({ params }) {
    let sessionManager = this.getSessionManager();
    let participants   = await sessionManager.getParticipants(params.sessionID);

    return { data: { participants } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/participants
  // ---------------------------------------------------------------------------

  async create({ params, body }) {
    let { agentID } = body || {};

    if (!agentID)
      this.throwBadRequestError('agentID is required');

    let sessionManager = this.getSessionManager();
    let participant    = await sessionManager.addParticipant(params.sessionID, agentID);

    this.setStatusCode(201);

    return { data: { participant } };
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/v2/sessions/:sessionID/participants/:id
  // ---------------------------------------------------------------------------

  async destroy({ params }) {
    let sessionManager = this.getSessionManager();
    let models         = this.getCoreModels();
    let { Participant } = models;

    // Look up participant to get sessionID and agentID for the new signature
    let participant = await Participant.where.id.EQ(params.participantID).first();
    if (!participant)
      this.throwNotFoundError('Participant not found');

    await sessionManager.removeParticipant(participant.sessionID, participant.agentID);

    return { data: { deleted: true } };
  }
}
