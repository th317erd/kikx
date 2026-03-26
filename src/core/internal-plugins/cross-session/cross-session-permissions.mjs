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
      return this._throwListSessions(args);

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

    // Build rich error context with human-readable names
    let sessionName = await this._resolveSessionName(sessionID);
    let agentName   = await this._resolveAgentName(agentID);
    let message     = args && args.message;

    let details = [];

    if (agentID) {
      details.push({
        label: 'Agent',
        value: agentName,
      });
    }

    if (sessionID) {
      details.push({
        label: 'Target Session',
        value: sessionName,
      });
    }

    if (message) {
      let preview = (message.length > 200) ? message.slice(0, 200) + '...' : message;
      details.push({
        label: 'Message',
        value: preview,
      });
    }

    throw new PermissionRequiredError('cross-session:postToSession', {
      title:       `Send Message to Session`,
      titleParams: { sessionName, agentName },
      description: `Agent '${agentName}' is attempting to send a message to session '${sessionName}'.`,
      details,
    });
  }

  // ---------------------------------------------------------------------------
  // listSessions — always throws rich error
  // ---------------------------------------------------------------------------

  _throwListSessions(args) {
    let agentID = args && args.agentID;

    throw new PermissionRequiredError('cross-session:listSessions', {
      title:       'List Sessions',
      description: 'Agent is requesting to list available sessions.',
      details:     agentID ? [{ label: 'Agent', value: agentID }] : [],
    });
  }

  // ---------------------------------------------------------------------------
  // createSession — always throws rich error
  // ---------------------------------------------------------------------------

  _throwCreateSession(args) {
    let details = [];

    let sessionTitle = args && args.title;
    if (sessionTitle) {
      details.push({
        label: 'Session Name',
        value: sessionTitle,
      });
    }

    if (args && args.agentID) {
      details.push({
        label: 'Agent',
        value: args.agentID,
      });
    }

    throw new PermissionRequiredError('cross-session:createSession', {
      title:       'Create New Session',
      description: sessionTitle
        ? `Agent is requesting to create a new session: '${sessionTitle}'.`
        : 'Agent is requesting to create a new session.',
      details,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async _resolveAgentName(agentID) {
    if (!agentID)
      return '(unknown agent)';

    try {
      let models = this._context.getProperty('models');
      if (!models)
        return agentID;

      let agent = await models.Agent.where.id.EQ(agentID).first();
      if (!agent)
        return agentID;

      return agent.name || '(unnamed agent)';
    } catch (_error) {
      return agentID;
    }
  }

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
