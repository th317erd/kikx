'use strict';

import { Permissions } from '../../permissions/permissions-base.mjs';
import { PermissionRequiredError } from '../../permissions/permission-required-error.mjs';

// =============================================================================
// CrossSessionPermissions
// =============================================================================
// Logic-based permission decisions for cross-session tools.
// Throws PermissionRequiredError with rich context for permission dialogs.
//
//   postToSession:  Auto-approved if agent is participant; rich error otherwise.
//   listSessions:   Always throws PermissionRequiredError with list context.
//   createSession:  Always throws PermissionRequiredError with create context.
//   Other tools:    Defer to normal rule matching (return null).
// =============================================================================

export class CrossSessionPermissions extends Permissions {
  // Logic-based permission decisions that bypass rule matching
  async checkPermission(featureName, args, _options) {
    if (featureName === 'cross-session:createSession')
      return this._throwCreateSession(args);

    if (featureName === 'cross-session:postToSession')
      return await this._checkPostToSession(args);

    if (featureName === 'cross-session:listSessions')
      return this._throwListSessions();

    // All other tools: defer to normal rule matching
    return null;
  }

  // createSession never matches rules — always requires explicit approval
  matchesRule(rule, args, metadata) {
    if (args && args.toolName === 'createSession')
      return { matches: false };

    return super.matchesRule(rule, args, metadata);
  }

  // ---------------------------------------------------------------------------
  // postToSession — auto-approve if participant, rich error otherwise
  // ---------------------------------------------------------------------------

  async _checkPostToSession(args) {
    let sessionID = args && args.sessionID;
    let agentID   = args && args.agentID;

    // Check participant status if we have both IDs
    if (sessionID && agentID) {
      let sessionManager = this._context.getProperty('sessionManager');
      if (sessionManager) {
        try {
          let participants  = await sessionManager.getParticipants(sessionID);
          let isParticipant = participants.some((p) => p.agentID === agentID);
          if (isParticipant)
            return false; // Auto-approved
        } catch (_error) {
          // Fall through to throw rich error
        }
      }
    }

    // Build rich error context
    let sessionName = await this._resolveSessionName(sessionID);
    let message     = args && args.message;

    let details = [];

    if (sessionID) {
      details.push({
        label: 'permission.detail.targetSession',
        value: sessionName + ' (' + sessionID + ')',
      });
    }

    if (message) {
      let preview = (message.length > 200) ? message.slice(0, 200) + '...' : message;
      details.push({
        label: 'permission.detail.messagePreview',
        value: preview,
      });
    }

    throw new PermissionRequiredError('cross-session:postToSession', {
      title:       'permission.crossSession.postTitle',
      titleParams: { sessionName: sessionName },
      description: 'permission.crossSession.postDescription',
      details,
    });
  }

  // ---------------------------------------------------------------------------
  // listSessions — always throws rich error
  // ---------------------------------------------------------------------------

  _throwListSessions() {
    throw new PermissionRequiredError('cross-session:listSessions', {
      title:       'permission.crossSession.listTitle',
      description: 'permission.crossSession.listDescription',
      details:     [],
    });
  }

  // ---------------------------------------------------------------------------
  // createSession — always throws rich error
  // ---------------------------------------------------------------------------

  _throwCreateSession(args) {
    let details = [];

    let title = args && args.title;
    if (title) {
      details.push({
        label: 'permission.detail.sessionTitle',
        value: title,
      });
    }

    throw new PermissionRequiredError('cross-session:createSession', {
      title:       'permission.crossSession.createTitle',
      description: 'permission.crossSession.createDescription',
      details,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async _resolveSessionName(sessionID) {
    if (!sessionID)
      return '(unknown)';

    try {
      let models  = this._context.getProperty('models');
      if (!models)
        return sessionID;

      let session = await models.Session.where.id.EQ(sessionID).first();
      if (!session)
        return sessionID;

      return session.name || '(unnamed)';
    } catch (_error) {
      return sessionID;
    }
  }
}
