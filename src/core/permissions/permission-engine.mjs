'use strict';

// =============================================================================
// PermissionEngine
// =============================================================================
// Core permissions logic with no HTTP dependencies (embeddable).
// Evaluates permission rules to determine if a tool call needs approval.
//
// Rule evaluation:
//   1. Load matching PermissionRule records for the feature
//   2. Filter by scope hierarchy (global -> session -> frame)
//   3. Sort by priority (descending)
//   4. First match wins: 'allow' = no approval needed, 'deny' = needs approval
//   5. No match = needs approval (default deny)
// =============================================================================

const SCOPE_HIERARCHY = ['frame', 'session', 'global'];

export class PermissionEngine {
  constructor(context) {
    if (!context)
      throw new Error('PermissionEngine requires a CascadingContext');

    this._context = context;
  }

  // ---------------------------------------------------------------------------
  // checkPermission
  // ---------------------------------------------------------------------------
  // Returns true if permission is NEEDED (no matching allow rule).
  // Returns false if an allow rule matches (no approval needed).
  //
  // options:
  //   organizationID — required, scopes rules to org
  //   scope          — current scope context ('global', 'session', 'frame')
  //   scopeID        — session or frame ID for scoped rules
  //   verifyFingerprint — if true, validate rule fingerprints (Step 19)
  //   userKey        — user key for fingerprint verification
  // ---------------------------------------------------------------------------

  async checkPermission(featureName, args, options = {}) {
    let { organizationID, scope, scopeID, verifyFingerprint, userKey } = options;
    let { PermissionRule } = this._getModels();

    // Build query: match feature name AND organization
    let query = PermissionRule.where
      .organizationID.EQ(organizationID)
      .featureName.EQ(featureName);

    let rules = await query.all();

    // Filter out expired rules
    let now          = new Date();
    let activeRules = rules.filter((rule) => {
      if (rule.expiresAt && new Date(rule.expiresAt) <= now)
        return false;

      return true;
    });

    // Filter by scope hierarchy — include rules at current scope level and broader
    activeRules = this._filterByScope(activeRules, scope, scopeID);

    // Verify fingerprints if requested (Step 19)
    if (verifyFingerprint && userKey)
      activeRules = this._filterByFingerprint(activeRules, userKey);

    // Sort by priority descending (higher priority = first evaluated)
    activeRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // First match wins
    for (let rule of activeRules) {
      if (rule.effect === 'allow')
        return false; // No permission needed

      if (rule.effect === 'deny')
        return true; // Permission needed
    }

    // No match = default deny (needs permission)
    return true;
  }

  // ---------------------------------------------------------------------------
  // createRule
  // ---------------------------------------------------------------------------
  // Creates a new permission rule.
  //
  // ruleData:
  //   organizationID, featureName, effect, scope, scopeID,
  //   metadata, priority, createdBy, userKey (for fingerprinting)
  // ---------------------------------------------------------------------------

  async createRule(ruleData) {
    let { PermissionRule } = this._getModels();

    let data = {
      organizationID: ruleData.organizationID,
      featureName:    ruleData.featureName,
      effect:         ruleData.effect,
      scope:          ruleData.scope || 'global',
      scopeID:        ruleData.scopeID || null,
      metadata:       ruleData.metadata ? JSON.stringify(ruleData.metadata) : null,
      priority:       ruleData.priority || 0,
      createdBy:      ruleData.createdBy,
      expiresAt:      ruleData.expiresAt || null,
    };

    // Fingerprint if userKey is provided (Step 19)
    if (ruleData.userKey) {
      let keystore = this._getKeystore();
      if (keystore) {
        let fingerprintData = `${data.organizationID}:${data.featureName}:${data.effect}:${data.scope}`;
        data.fingerprint    = keystore.fingerprint(fingerprintData, ruleData.userKey);
      }
    }

    return await PermissionRule.create(data);
  }

  // ---------------------------------------------------------------------------
  // deleteRule
  // ---------------------------------------------------------------------------

  async deleteRule(ruleId) {
    let { PermissionRule } = this._getModels();
    let rule               = await PermissionRule.where.id.EQ(ruleId).first();

    if (!rule)
      return false;

    await rule.destroy();

    return true;
  }

  // ---------------------------------------------------------------------------
  // pruneExpired — delete expired rules
  // ---------------------------------------------------------------------------

  async pruneExpired() {
    let { PermissionRule } = this._getModels();
    let now                = new Date();
    let expired            = await PermissionRule.where.expiresAt.LTE(now).all();
    let count              = 0;

    for (let rule of expired) {
      await rule.destroy();
      count++;
    }

    return count;
  }

  // ---------------------------------------------------------------------------
  // getRules — query rules for an org
  // ---------------------------------------------------------------------------

  async getRules(organizationID, filters = {}) {
    let { PermissionRule } = this._getModels();
    let query              = PermissionRule.where.organizationID.EQ(organizationID);

    if (filters.featureName)
      query = query.featureName.EQ(filters.featureName);

    if (filters.scope)
      query = query.scope.EQ(filters.scope);

    return await query.all();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _getModels() {
    return this._context.getProperty('models');
  }

  _getKeystore() {
    return this._context.getProperty('keystore');
  }

  _filterByScope(rules, currentScope, currentScopeID) {
    if (!currentScope)
      return rules;

    let currentIndex = SCOPE_HIERARCHY.indexOf(currentScope);
    if (currentIndex < 0)
      return rules;

    // Include rules at the current scope level and broader (higher index in hierarchy)
    let allowedScopes = SCOPE_HIERARCHY.slice(currentIndex);

    return rules.filter((rule) => {
      let ruleScope = rule.scope || 'global';

      // Global rules always apply
      if (ruleScope === 'global')
        return true;

      // Check if rule scope is allowed
      if (!allowedScopes.includes(ruleScope))
        return false;

      // For session/frame scoped rules, scopeID must match
      if (ruleScope === 'session' || ruleScope === 'frame') {
        if (rule.scopeID && currentScopeID)
          return rule.scopeID === currentScopeID;

        // If no scopeID on rule, it applies to all sessions/frames
        return true;
      }

      return true;
    });
  }

  _filterByFingerprint(rules, userKey) {
    let keystore = this._getKeystore();
    if (!keystore)
      return rules;

    return rules.filter((rule) => {
      // Rules without fingerprints are untrusted when verification is enabled
      if (!rule.fingerprint)
        return false;

      // Recompute fingerprint and compare
      let fingerprintData = `${rule.organizationID}:${rule.featureName}:${rule.effect}:${rule.scope}`;
      let expected        = keystore.fingerprint(fingerprintData, userKey);

      return rule.fingerprint === expected;
    });
  }
}
