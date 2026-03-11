'use strict';

import { Permissions } from '../../permissions/permissions-base.mjs';

// =============================================================================
// CrossSessionPermissions
// =============================================================================
// Logic-based permission decisions for cross-session tools.
//
//   createSession:  ALWAYS requires explicit approval (short-circuits rules).
//   postToSession:  Auto-approved if agent is participant in target session.
//   Other tools:    Defer to normal rule matching.
// =============================================================================

export class CrossSessionPermissions extends Permissions {
  // Logic-based permission decisions that bypass rule matching
  async checkPermission(featureName, args, _options) {
    // createSession ALWAYS requires explicit approval (no rule matching)
    if (featureName === 'cross-session:createSession')
      return true;

    // postToSession: auto-approve if agent is a participant in the target session
    if (featureName === 'cross-session:postToSession')
      return await this._checkPostToSession(args);

    // All other tools: defer to normal rule matching
    return null;
  }

  // createSession never matches rules — always requires explicit approval
  matchesRule(rule, args, metadata) {
    if (args && args.toolName === 'createSession')
      return { matches: false };

    return super.matchesRule(rule, args, metadata);
  }

  async _checkPostToSession(args) {
    let sessionID = args && args.sessionID;
    let agentID   = args && args.agentID;

    if (!sessionID || !agentID)
      return null; // Defer — can't determine without IDs

    let sessionManager = this._context.getProperty('sessionManager');
    if (!sessionManager)
      return null; // Defer gracefully

    try {
      let participants  = await sessionManager.getParticipants(sessionID);
      let isParticipant = participants.some((p) => p.agentID === agentID);
      return isParticipant ? false : null; // false = auto-approved, null = defer to rules
    } catch (_error) {
      return null; // Error checking — defer gracefully
    }
  }
}
