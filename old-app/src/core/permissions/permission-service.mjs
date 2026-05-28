'use strict';

import { Permissions }  from './permissions-base.mjs';
import { safeParseJSON } from '../lib/utils.mjs';

// =============================================================================
// PermissionService
// =============================================================================

export class PermissionService {
  /**
   * @param {object} [options]
   * @param {import('../types').CascadingContext} options.context
   * @param {import('../types').Keystore} options.keystore
   */
  constructor(options = {}) {
    /** @type {import('../types').CascadingContext} */
    this._context          = options.context;
    /** @type {import('../types').Keystore} */
    this._keystore         = options.keystore;

    if (!this._context)
      throw new Error('PermissionService requires context');

    if (!this._keystore)
      throw new Error('PermissionService requires keystore');

    /** @type {Permissions|null} */
    this._permissions = null;
  }

  /**
   * @returns {Permissions}
   */
  _getPermissions() {
    if (!this._permissions)
      this._permissions = new Permissions(this._context);

    return this._permissions;
  }

  // ---------------------------------------------------------------------------
  // check — Evaluate permission and optionally sign approval
  // ---------------------------------------------------------------------------
  /**
   * @param {string} featureName
   * @param {any} args
   * @param {object} [options]
   * @param {string} [options.organizationID]
   * @param {string} [options.sessionID]
   * @param {any} [options.toolClass]
   * @param {object} [options.pluginRegistry]
   * @param {string} [options.privateKeyPEM]
   * @param {import('../types').Agent} [options.agent]
   * @param {import('../types').User} [options.user]
   * @returns {Promise<{ decision: 'allow', signature: string } | { decision: 'needs-approval' }>}
   */
  async check(featureName, args, options = {}) {
    let { organizationID, sessionID, toolClass, pluginRegistry, privateKeyPEM, agent, user } = options;

    // Look up tool class from registry if not provided
    if (!toolClass && pluginRegistry)
      toolClass = pluginRegistry.getTool(featureName);

    let needsPermission = await this._getPermissions().evaluate(featureName, args, {
      organizationID,
      scope:   sessionID ? 'session' : 'global',
      scopeID: sessionID || null,
      toolClass,
      agent,
      user,
    });

    if (!needsPermission) {
      // Approved — sign the approval envelope
      let signature = this._signApproval('approve', null, featureName, args, sessionID, privateKeyPEM);
      return { decision: 'allow', signature };
    }

    return { decision: 'needs-approval' };
  }

  // ---------------------------------------------------------------------------
  // createStandingApproval — Session-scoped allow rule
  // ---------------------------------------------------------------------------
  /**
   * @param {object} [options]
   * @param {string} options.organizationID
   * @param {string} options.sessionID
   * @param {string} [options.featureName]
   * @param {string} [options.createdBy]
   * @param {Date} [options.expiresAt]
   * @param {number} [options.priority]
   * @param {string} [options.privateKeyPEM]
   * @returns {Promise<import('../types').PermissionRule>}
   */
  async createStandingApproval(options = {}) {
    let { organizationID, sessionID, featureName, createdBy, expiresAt, priority, privateKeyPEM } = options;

    if (!organizationID)
      throw new Error('organizationID is required');

    if (!sessionID)
      throw new Error('sessionID is required for standing approvals');

    let effectiveFeature = featureName || '*';
    let effectivePriority = priority !== undefined ? priority : 100;

    // Sign the standing approval
    let signature = this._signApproval('approve', null, effectiveFeature, { standing: true, sessionID }, sessionID, privateKeyPEM);

    let rule = await this._getPermissions().createRule({
      organizationID,
      featureName: effectiveFeature,
      effect:      'allow',
      scope:       'session',
      scopeID:     sessionID,
      priority:    effectivePriority,
      createdBy:   createdBy || null,
      expiresAt:   expiresAt || null,
      metadata:    { standing: true, signature },
    });

    return rule;
  }

  // ---------------------------------------------------------------------------
  // revokeStandingApproval — Remove standing approval for a session
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionID
   * @param {object} [options]
   * @param {string} options.organizationID
   * @param {string} [options.featureName]
   * @returns {Promise<number>} Count of revoked rules
   */
  async revokeStandingApproval(sessionID, options = {}) {
    let { organizationID, featureName } = options;

    if (!organizationID)
      throw new Error('organizationID is required');

    if (!sessionID)
      throw new Error('sessionID is required');

    let rules = await this._getPermissions().getRules(organizationID, {
      featureName: featureName || undefined,
      scope:       'session',
    });

    let revoked = 0;

    for (let rule of rules) {
      if (rule.scopeID !== sessionID)
        continue;

      let metadata = safeParseJSON(rule.metadata);
      if (!metadata.standing)
        continue;

      if (featureName && rule.featureName !== featureName)
        continue;

      await this._getPermissions().deleteRule(rule.id);
      revoked++;
    }

    return revoked;
  }

  // ---------------------------------------------------------------------------
  // signApproval / verifyApproval — Envelope signing
  // ---------------------------------------------------------------------------

  /**
   * @param {string} action
   * @param {string|null} frameID
   * @param {string} toolName
   * @param {any} args
   * @param {string|null} sessionID
   * @param {string} [privateKeyPEM]
   * @returns {string}
   */
  signApproval(action, frameID, toolName, args, sessionID, privateKeyPEM) {
    return this._signApproval(action, frameID, toolName, args, sessionID || null, privateKeyPEM);
  }

  /**
   * @param {string} action
   * @param {string|null} frameID
   * @param {string} toolName
   * @param {any} args
   * @param {string} signature
   * @param {string|null} sessionID
   * @param {string} [publicKeyPEM]
   * @returns {boolean}
   */
  verifyApproval(action, frameID, toolName, args, signature, sessionID, publicKeyPEM) {
    let blob = this._buildApprovalBlob(action, frameID, toolName, args, sessionID);
    try {
      if (publicKeyPEM)
        return this._keystore.verifyWithPublicKey(blob, publicKeyPEM, signature);

      // Fallback to HMAC verification (backward compat during transition)
      return this._keystore.verify(blob, signature);
    } catch (_error) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * @param {string} action
   * @param {string|null} frameID
   * @param {string} toolName
   * @param {any} args
   * @param {string|null} sessionID
   * @param {string} [privateKeyPEM]
   * @returns {string}
   */
  _signApproval(action, frameID, toolName, args, sessionID, privateKeyPEM) {
    let blob = this._buildApprovalBlob(action, frameID, toolName, args, sessionID);
    if (privateKeyPEM)
      return this._keystore.signWithPrivateKey(blob, privateKeyPEM);

    // Fallback to HMAC if no private key provided (backward compat during transition)
    return this._keystore.sign(blob);
  }

  /**
   * @param {string} action
   * @param {string|null} frameID
   * @param {string} toolName
   * @param {any} args
   * @param {string|null} sessionID
   * @returns {{ action: string, frameID: string|null, toolName: string|null, arguments: any, sessionID: string|null }}
   */
  _buildApprovalBlob(action, frameID, toolName, args, sessionID) {
    return {
      action:    action || 'approve',
      frameID:   frameID || null,
      toolName:  toolName || null,
      arguments: args || {},
      sessionID: sessionID || null,
    };
  }
}
