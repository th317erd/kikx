'use strict';

// =============================================================================
// CostController — Aggregated token cost queries
// =============================================================================
// GET /api/v2/cost?sessionID=xxx&serviceType=yyy
//
// Returns aggregated token usage for three scopes:
//   global  — all tokens for this organization
//   service — tokens for the given serviceType (omitted if no serviceType)
//   session — tokens for the given sessionID (omitted if no sessionID)
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class CostController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/cost
  // ---------------------------------------------------------------------------

  async show({ query }) {
    let models         = this.getCoreModels();
    let Token          = models.Token;
    let organizationID = this.request.organizationID;

    if (!Token)
      return { data: { global: null, service: null, session: null } };

    let sessionID   = (query && query.sessionID) || null;
    let serviceType = (query && query.serviceType) || null;

    // Global: all tokens for this organization
    let globalTokens = await Token
      .where.organizationID.EQ(organizationID)
      .all();

    let global = this._aggregate(globalTokens);

    // Service: tokens for this serviceType within this organization
    let service = null;
    if (serviceType) {
      let serviceTokens = await Token
        .where.organizationID.EQ(organizationID)
        .serviceType.EQ(serviceType)
        .all();

      service = this._aggregate(serviceTokens);
    }

    // Session: tokens for this specific session
    let session = null;
    if (sessionID) {
      let sessionTokens = await Token
        .where.organizationID.EQ(organizationID)
        .sessionID.EQ(sessionID)
        .all();

      session = this._aggregate(sessionTokens);
    }

    return { data: { global, service, session } };
  }

  _aggregate(tokens) {
    let result = {
      inputTokens:              0,
      outputTokens:             0,
      cacheReadInputTokens:     0,
      cacheCreationInputTokens: 0,
    };

    for (let token of tokens) {
      result.inputTokens              += token.inputTokens || 0;
      result.outputTokens             += token.outputTokens || 0;
      result.cacheReadInputTokens     += token.cacheReadInputTokens || 0;
      result.cacheCreationInputTokens += token.cacheCreationInputTokens || 0;
    }

    return result;
  }
}
