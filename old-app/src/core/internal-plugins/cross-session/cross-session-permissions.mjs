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
  // Logic-based permission decisions — checks standing rules first,
  // only throws rich PermissionRequiredError if no rule approves.
  /**
   * @param {string} featureName
   * @param {Record<string, any>} args
   * @param {Record<string, any>} options
   * @returns {Promise<boolean | null>}
   */
  async checkPermission(featureName, args, options) {
    if (featureName === 'cross-session:postToSession')
      return await this._checkPostToSession(args, options);

    if (featureName === 'cross-session:listSessions')
      return await this._checkWithRichError(featureName, args, options, () => this._throwListSessions(args));

    if (featureName === 'cross-session:createSession')
      return await this._checkWithRichError(featureName, args, options, () => this._throwCreateSession(args));

    // All other tools: defer to normal rule matching
    return null;
  }

  // Check standing rules first — if approved, return false.
  // If not, throw the rich error from the callback.
  /**
   * @param {string} featureName
   * @param {Record<string, any>} args
   * @param {Record<string, any>} options
   * @param {() => never} throwRichError
   * @returns {Promise<boolean | never>}
   */
  async _checkWithRichError(featureName, args, options, throwRichError) {
    try {
      let needsApproval = await this.evaluate(featureName, args, options);
      if (!needsApproval)
        return false; // Standing rule approved
    } catch (err) {
      throw err; // PermissionDeniedError — propagate
    }

    // No standing rule — throw rich error for the permission dialog
    return throwRichError();
  }

  // createSession never matches rules — always requires explicit approval
  /**
   * @param {import('../../types').PermissionRule} rule
   * @param {Record<string, any>} args
   * @param {Record<string, any>} metadata
   * @returns {{ matches: boolean }}
   */
  matchesRule(rule, args, metadata) {
    if ((args && args.toolName === 'createSession') || (rule && rule.featureName === 'cross-session:createSession'))
      return { matches: false };

    return super.matchesRule(rule, args, metadata);
  }

  // ---------------------------------------------------------------------------
  // postToSession — auto-approve if participant, rich error otherwise
  // ---------------------------------------------------------------------------

  /**
   * @param {Record<string, any>} args
   * @param {Record<string, any>} options
   * @returns {Promise<boolean | never>}
   */
  async _checkPostToSession(args, options) {
    let sessionID = args && args.sessionID;
    let agentID   = args && args.agentID;

    // Check standing rules first (e.g., allow-forever from a previous approval)
    try {
      let needsApproval = await this.evaluate('cross-session:postToSession', args, options);
      if (!needsApproval)
        return false; // Standing rule approved
    } catch (err) {
      throw err; // PermissionDeniedError — propagate
    }

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

  /**
   * @param {Record<string, any>} args
   * @returns {never}
   */
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

  /**
   * @param {Record<string, any>} args
   * @returns {never}
   */
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

  /**
   * @param {string | null} agentID
   * @returns {Promise<string>}
   */
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

  /**
   * @param {string | null} sessionID
   * @returns {Promise<string>}
   */
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
