'use strict';

// =============================================================================
// PermissionService
// =============================================================================
// High-level permission service wrapping PermissionEngine + Keystore signing.
// Provides a unified interface for:
//   - Checking permissions (with optional signing on approval)
//   - Creating standing approvals (session-scoped allow rules)
//   - Signing and verifying approval envelopes
//
// Available on CascadingContext as 'permissionService'. Used by:
//   - BasePluginClass.checkPermission() — routing plugins
//   - InteractionLoop (via params.checkPermission closure)
//   - InteractionController (replaces inline permission logic)
// =============================================================================

export class PermissionService {
  constructor(options = {}) {
    this._context          = options.context;
    this._permissionEngine = options.permissionEngine;
    this._keystore         = options.keystore;

    if (!this._context)
      throw new Error('PermissionService requires context');

    if (!this._permissionEngine)
      throw new Error('PermissionService requires permissionEngine');

    if (!this._keystore)
      throw new Error('PermissionService requires keystore');
  }

  // ---------------------------------------------------------------------------
  // check — Evaluate permission and optionally sign approval
  // ---------------------------------------------------------------------------
  // Returns:
  //   { decision: 'allow', signature }   — tool call is approved
  //   { decision: 'needs-approval' }     — manual approval required
  //   { decision: 'no-engine' }          — no permission engine available
  //
  // Throws PermissionDeniedError for explicit deny rules.
  // ---------------------------------------------------------------------------

  async check(featureName, args, options = {}) {
    let { organizationID, sessionID, toolClass, pluginRegistry, privateKeyPEM, agent, user } = options;

    // Look up tool class from registry if not provided
    if (!toolClass && pluginRegistry)
      toolClass = pluginRegistry.getTool(featureName);

    let needsPermission = await this._permissionEngine.checkPermission(featureName, args, {
      organizationID,
      scope:   sessionID ? 'session' : 'global',
      scopeID: sessionID || null,
      toolClass,
      agent,
      user,
    });

    if (!needsPermission) {
      // Approved — sign the approval envelope
      let signature = this._signApproval(featureName, args, sessionID, privateKeyPEM);
      return { decision: 'allow', signature };
    }

    return { decision: 'needs-approval' };
  }

  // ---------------------------------------------------------------------------
  // createStandingApproval — Session-scoped allow rule
  // ---------------------------------------------------------------------------
  // Creates a signed session-scoped allow rule that auto-approves matching
  // tool calls for the duration of the session (or until expiry).
  //
  // options:
  //   organizationID — required
  //   sessionID      — required (scope)
  //   featureName    — tool/feature name (or '*' for all)
  //   createdBy      — user ID who created the approval
  //   expiresAt      — optional expiry Date
  //   priority       — optional rule priority (default: 100, high priority)
  // ---------------------------------------------------------------------------

  async createStandingApproval(options = {}) {
    let { organizationID, sessionID, featureName, createdBy, expiresAt, priority, privateKeyPEM } = options;

    if (!organizationID)
      throw new Error('organizationID is required');

    if (!sessionID)
      throw new Error('sessionID is required for standing approvals');

    let effectiveFeature = featureName || '*';
    let effectivePriority = priority !== undefined ? priority : 100;

    // Sign the standing approval
    let signature = this._signApproval(effectiveFeature, { standing: true, sessionID }, sessionID, privateKeyPEM);

    let rule = await this._permissionEngine.createRule({
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

  async revokeStandingApproval(sessionID, options = {}) {
    let { organizationID, featureName } = options;

    if (!organizationID)
      throw new Error('organizationID is required');

    if (!sessionID)
      throw new Error('sessionID is required');

    let rules = await this._permissionEngine.getRules(organizationID, {
      featureName: featureName || undefined,
      scope:       'session',
    });

    let revoked = 0;

    for (let rule of rules) {
      if (rule.scopeID !== sessionID)
        continue;

      let metadata = rule.metadata ? JSON.parse(rule.metadata) : {};
      if (!metadata.standing)
        continue;

      if (featureName && rule.featureName !== featureName)
        continue;

      await this._permissionEngine.deleteRule(rule.id);
      revoked++;
    }

    return revoked;
  }

  // ---------------------------------------------------------------------------
  // signApproval / verifyApproval — Envelope signing
  // ---------------------------------------------------------------------------

  signApproval(featureName, args, sessionID, privateKeyPEM) {
    return this._signApproval(featureName, args, sessionID || null, privateKeyPEM);
  }

  verifyApproval(featureName, args, signature, sessionID, publicKeyPEM) {
    let blob = this._buildApprovalBlob(featureName, args, sessionID);
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

  _signApproval(featureName, args, sessionID, privateKeyPEM) {
    let blob = this._buildApprovalBlob(featureName, args, sessionID);
    if (privateKeyPEM)
      return this._keystore.signWithPrivateKey(blob, privateKeyPEM);

    // Fallback to HMAC if no private key provided (backward compat during transition)
    return this._keystore.sign(blob);
  }

  _buildApprovalBlob(featureName, args, sessionID) {
    return {
      action:      'approve',
      featureName,
      args:        args || {},
      sessionID:   sessionID || null,
    };
  }
}
