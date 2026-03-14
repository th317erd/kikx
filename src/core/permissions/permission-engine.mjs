'use strict';

import { PermissionDeniedError } from './permission-denied-error.mjs';

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
//   4. Custom matching via toolClass.getPermissionsClass() if available
//   5. First match wins:
//      - 'deny'  = throw PermissionDeniedError (fail-fast, no approval)
//      - 'allow' = no approval needed (unless safety net applies)
//   6. No match = needs approval (default deny)
//
// Safety net: If toolClass.riskLevel === 'critical', allow rules are
// ignored — the tool always needs manual approval.
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
  //   userKey        — user key for fingerprint verification (HMAC)
  //   publicKeyPEM   — Ed25519 public key for fingerprint verification
  // ---------------------------------------------------------------------------

  async checkPermission(featureName, args, options = {}) {
    let { organizationID, scope, scopeID, verifyFingerprint, userKey, publicKeyPEM, toolClass } = options;
    let { PermissionRule } = this._getModels();

    // Auto-allow tools with no risk (e.g. help:search)
    if (toolClass && toolClass.riskLevel === 'none')
      return false;

    // Safety net: critical tools always need approval regardless of rules
    if (toolClass && toolClass.riskLevel === 'critical')
      return true;

    // Resolve the effective risk level from agent config, user settings, or default
    let riskLevel = await this._resolveRiskLevel(options);

    // Build query: match feature name AND organization
    let query = PermissionRule.where
      .organizationID.EQ(organizationID)
      .featureName.EQ(featureName);

    let rules = await query.all();

    // Filter out expired rules
    let now         = new Date();
    let activeRules = rules.filter((rule) => {
      if (rule.expiresAt && new Date(rule.expiresAt) <= now)
        return false;

      return true;
    });

    // Build ancestry chain for session walk-up (if session context is available)
    let sessionManager     = this._context.getProperty('sessionManager');
    let ancestorSessionIDs = [];

    if (sessionManager && scopeID)
      ancestorSessionIDs = await sessionManager.getAncestryChain(scopeID);

    // Strict mode: restrict ancestry walk-up — session-scoped rules only match
    // the exact current session, not parent sessions.
    if (riskLevel === 'strict')
      ancestorSessionIDs = [];

    // Filter by scope hierarchy — include rules at current scope level and broader.
    // If ancestry walk-up is available, include rules scoped to ancestor sessions.
    activeRules = this._filterByScopeWithAncestry(activeRules, scope, scopeID, ancestorSessionIDs);

    // Verify fingerprints if requested (Step 19)
    if (verifyFingerprint && (userKey || publicKeyPEM))
      activeRules = this._filterByFingerprint(activeRules, userKey, publicKeyPEM);

    // Sort by ancestry distance (closer ancestors first), then by priority
    // descending within each distance level.
    if (ancestorSessionIDs.length > 0) {
      let distanceMap = new Map();
      for (let index = 0; index < ancestorSessionIDs.length; index++)
        distanceMap.set(ancestorSessionIDs[index], index);

      activeRules.sort((a, b) => {
        let distanceA = (a.scope === 'session' && a.scopeID) ? (distanceMap.get(a.scopeID) ?? Infinity) : Infinity;
        let distanceB = (b.scope === 'session' && b.scopeID) ? (distanceMap.get(b.scopeID) ?? Infinity) : Infinity;

        // Closer ancestor first (lower distance)
        if (distanceA !== distanceB)
          return distanceA - distanceB;

        // Within same distance, higher priority first
        return (b.priority || 0) - (a.priority || 0);
      });
    } else {
      // No ancestry — original sort by priority descending
      activeRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    // Custom matching via Permissions subclass if toolClass provides one
    let permissionsInstance = null;
    if (toolClass && typeof toolClass.prototype.getPermissionsClass === 'function') {
      let PermissionsClass = new toolClass(this._context).getPermissionsClass();
      if (PermissionsClass)
        permissionsInstance = new PermissionsClass(this._context);
    }

    // Pre-rule logic: checkPermission() can short-circuit the entire rule loop
    if (permissionsInstance) {
      let preRuleResult = await permissionsInstance.checkPermission(featureName, args, options);
      if (preRuleResult !== null)
        return preRuleResult;
    }

    // First match wins
    for (let rule of activeRules) {
      // Custom matching: if tool has a Permissions class, check matchesRule
      if (permissionsInstance) {
        let metadata    = permissionsInstance._parseMetadata(rule);
        let matchResult = permissionsInstance.matchesRule(rule, args, metadata);

        if (matchResult && matchResult.matches === false)
          continue; // Rule doesn't match per custom logic, skip
      }

      if (rule.effect === 'deny')
        throw new PermissionDeniedError(featureName, 'explicit deny rule');

      if (rule.effect === 'allow')
        return false; // No permission needed
    }

    // No match: permissive mode auto-allows, all others default deny
    if (riskLevel === 'permissive')
      return false;

    return true;
  }

  // ---------------------------------------------------------------------------
  // createRule
  // ---------------------------------------------------------------------------
  // Creates a new permission rule.
  //
  // ruleData:
  //   organizationID, featureName, effect, scope, scopeID,
  //   metadata, priority, createdBy,
  //   privateKeyPEM (Ed25519 fingerprinting), userKey (HMAC fingerprinting)
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

    // Fingerprint: Ed25519 signature (preferred) or HMAC fallback
    if (ruleData.privateKeyPEM) {
      let keystore = this._getKeystore();
      if (keystore) {
        let fingerprintData = `${data.organizationID}:${data.featureName}:${data.effect}:${data.scope}`;
        data.fingerprint    = keystore.signWithPrivateKey(fingerprintData, ruleData.privateKeyPEM);
      }
    } else if (ruleData.userKey) {
      // Backward compat: HMAC fingerprint (Step 19)
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

  async deleteRule(ruleID) {
    let { PermissionRule } = this._getModels();
    let rule               = await PermissionRule.where.id.EQ(ruleID).first();

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
  // _resolveRiskLevel — resolve effective risk level from options chain
  // ---------------------------------------------------------------------------
  // Resolution order:
  //   1. options.riskLevel (pre-resolved, explicit override)
  //   2. options.agent.getConfig().riskLevel
  //   3. options.user.getSettings().riskLevel
  //   4. Default: 'strict'
  //
  // Backward compat: 'medium' is treated as 'normal'.
  // Valid values: 'strict', 'normal', 'permissive'
  // ---------------------------------------------------------------------------

  async _resolveRiskLevel(options = {}) {
    let resolved;

    // 1. Explicit override from options
    if (options.riskLevel) {
      resolved = options.riskLevel;
    } else {
      // 2. Agent config
      let agent  = options.agent;
      let config = (agent && typeof agent.getConfig === 'function') ? await agent.getConfig() : null;

      if (config && config.riskLevel) {
        resolved = config.riskLevel;
      } else {
        // 3. User settings
        let user     = options.user;
        let settings = (user && typeof user.getSettings === 'function') ? await user.getSettings() : null;

        if (settings && settings.riskLevel)
          resolved = settings.riskLevel;
        else
          resolved = 'strict'; // 4. Default
      }
    }

    // Backward compat: 'medium' → 'normal'
    if (resolved === 'medium')
      resolved = 'normal';

    // Validate
    let validLevels = new Set(['strict', 'normal', 'permissive']);
    if (!validLevels.has(resolved))
      throw new Error(`Invalid risk level: ${resolved}`);

    return resolved;
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
    return this._filterByScopeWithAncestry(rules, currentScope, currentScopeID, []);
  }

  _filterByScopeWithAncestry(rules, currentScope, currentScopeID, ancestorSessionIDs) {
    if (!currentScope)
      return rules;

    let currentIndex = SCOPE_HIERARCHY.indexOf(currentScope);
    if (currentIndex < 0)
      return rules;

    // Include rules at the current scope level and broader (higher index in hierarchy)
    let allowedScopes = SCOPE_HIERARCHY.slice(currentIndex);

    // Build set of valid session IDs (self + ancestors) for walk-up matching
    let validSessionIDs = new Set();

    if (currentScopeID)
      validSessionIDs.add(currentScopeID);

    for (let ancestorID of ancestorSessionIDs)
      validSessionIDs.add(ancestorID);

    return rules.filter((rule) => {
      let ruleScope = rule.scope || 'global';

      // Global rules always apply
      if (ruleScope === 'global')
        return true;

      // Check if rule scope is allowed
      if (!allowedScopes.includes(ruleScope))
        return false;

      // For session-scoped rules, check if scopeID matches self or any ancestor
      if (ruleScope === 'session') {
        if (rule.scopeID) {
          if (validSessionIDs.size > 0)
            return validSessionIDs.has(rule.scopeID);

          return rule.scopeID === currentScopeID;
        }

        // If no scopeID on rule, it applies to all sessions
        return true;
      }

      // For frame-scoped rules, scopeID must match exactly (no walk-up)
      if (ruleScope === 'frame') {
        if (rule.scopeID && currentScopeID)
          return rule.scopeID === currentScopeID;

        return true;
      }

      return true;
    });
  }

  _filterByFingerprint(rules, userKey, publicKeyPEM) {
    let keystore = this._getKeystore();
    if (!keystore)
      return rules;

    return rules.filter((rule) => {
      // Rules without fingerprints are untrusted when verification is enabled
      if (!rule.fingerprint)
        return false;

      let fingerprintData = `${rule.organizationID}:${rule.featureName}:${rule.effect}:${rule.scope}`;

      // Try Ed25519 verification first
      if (publicKeyPEM) {
        let valid = keystore.verifyWithPublicKey(fingerprintData, publicKeyPEM, rule.fingerprint);
        if (valid)
          return true;
      }

      // Fallback to HMAC verification
      if (userKey) {
        let expected = keystore.fingerprint(fingerprintData, userKey);
        return rule.fingerprint === expected;
      }

      return false;
    });
  }
}
