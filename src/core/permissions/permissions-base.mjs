'use strict';

import { PermissionDeniedError } from './permission-denied-error.mjs';

// =============================================================================
// Permissions Base Class
// =============================================================================
// Base class for plugin-specific permission logic.
// Plugins can subclass this and override matchesRule() to implement
// custom rule matching (e.g., command-level shell permissions).
//
// Override points:
//   matchesRule(rule, args, metadata) — per-rule matching during rule loop.
//     Return { matches: true } if the rule applies, { matches: false } to skip.
//
//   checkPermission(featureName, args, options) — pre-rule logic override.
//     Return true  = needs approval (short-circuit, skip rule matching).
//     Return false = auto-approved (short-circuit, skip rule matching).
//     Return null  = defer to normal rule matching (default).
//
//   evaluate(featureName, args, options) — full rule evaluation.
//     Full rule evaluation logic. Each PermissionsClass can evaluate rules
//     Permissions base class. Each PermissionsClass can evaluate rules
//     without going through the engine.
// =============================================================================

const SCOPE_HIERARCHY = ['frame', 'session', 'global'];

export class Permissions {
  constructor(context) {
    this._context = context;
  }

  // Override for logic-based permission decisions that bypass rule matching.
  // Return true (needs approval), false (auto-approved), or null (defer).
  // eslint-disable-next-line no-unused-vars
  async checkPermission(_featureName, _args, _options) {
    return null; // default: defer to rule matching
  }

  // Override for custom rule matching. Returns { matches: boolean }
  matchesRule(_rule, _args, _metadata) {
    return { matches: true }; // default: rule always matches
  }

  // ---------------------------------------------------------------------------
  // evaluate — full rule evaluation
  // ---------------------------------------------------------------------------
  // Returns true  = needs approval (no matching allow rule)
  // Returns false = auto-approved (matching allow rule, or auto-allow)
  // Throws PermissionDeniedError = explicit deny rule matched
  //
  // options:
  //   organizationID — scopes rules to org
  //   scope          — current scope context ('global', 'session', 'frame')
  //   scopeID        — session or frame ID for scoped rules
  //   riskLevel      — explicit risk level override
  //   agent          — agent object with getConfig() for risk level resolution
  //   user           — user object with getSettings() for risk level resolution
  //   toolClass      — tool class with static riskLevel for safety net checks
  //   verifyFingerprint — if true, validate rule fingerprints
  //   userKey        — user key for fingerprint verification (HMAC)
  //   publicKeyPEM   — Ed25519 public key for fingerprint verification
  // ---------------------------------------------------------------------------

  async evaluate(featureName, args, options = {}) {
    let { organizationID, scope, scopeID, toolClass, verifyFingerprint, userKey, publicKeyPEM } = options;

    // Safety net: tools with riskLevel 'none' auto-allow
    if (toolClass && toolClass.riskLevel === 'none')
      return false;

    // Safety net: critical tools always need approval regardless of rules
    if (toolClass && toolClass.riskLevel === 'critical')
      return true;

    // Resolve the effective risk level
    let riskLevel = await this._resolveRiskLevel(options);

    // Load matching rules
    let models = this._getModels();
    if (!models || !models.PermissionRule)
      return false; // No models available — allow (development/test mode)

    let { PermissionRule } = models;
    let rules = await PermissionRule.where
      .organizationID.EQ(organizationID)
      .featureName.EQ(featureName)
      .all();

    // Filter out expired rules
    let now         = new Date();
    let activeRules = rules.filter((rule) => {
      if (rule.expiresAt && new Date(rule.expiresAt) <= now)
        return false;

      return true;
    });

    // Build ancestry chain for session walk-up
    let sessionManager     = this._context.getProperty('sessionManager');
    let ancestorSessionIDs = [];

    if (sessionManager && scopeID)
      ancestorSessionIDs = await sessionManager.getAncestryChain(scopeID);

    // Strict mode: no ancestry walk-up
    if (riskLevel === 'strict')
      ancestorSessionIDs = [];

    // Filter by scope hierarchy with ancestry
    activeRules = this._filterByScopeWithAncestry(activeRules, scope, scopeID, ancestorSessionIDs);

    // Verify fingerprints if requested
    if (verifyFingerprint && (userKey || publicKeyPEM))
      activeRules = this._filterByFingerprint(activeRules, userKey, publicKeyPEM);

    // Sort by ancestry distance (closer ancestors first), then by priority
    if (ancestorSessionIDs.length > 0) {
      let distanceMap = new Map();
      for (let index = 0; index < ancestorSessionIDs.length; index++)
        distanceMap.set(ancestorSessionIDs[index], index);

      activeRules.sort((a, b) => {
        let distanceA = (a.scope === 'session' && a.scopeID) ? (distanceMap.get(a.scopeID) ?? Infinity) : Infinity;
        let distanceB = (b.scope === 'session' && b.scopeID) ? (distanceMap.get(b.scopeID) ?? Infinity) : Infinity;

        if (distanceA !== distanceB)
          return distanceA - distanceB;

        return (b.priority || 0) - (a.priority || 0);
      });
    } else {
      activeRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    // Discover custom Permissions subclass from toolClass if available.
    // This allows tool-specific matchesRule() logic (e.g., ShellPermissions
    // matching command arguments).
    let permissionsInstance = this;

    if (toolClass && typeof toolClass.prototype.getPermissionsClass === 'function') {
      let PermissionsClass = new toolClass(this._context).getPermissionsClass();
      if (PermissionsClass)
        permissionsInstance = new PermissionsClass(this._context);
    }

    // First match wins
    for (let rule of activeRules) {
      let metadata = permissionsInstance._parseMetadata(rule);

      // Skip consumed one-time rules — they've been used and should not match again
      if (metadata.oneTime && metadata.consumed)
        continue;

      // Custom matching via permissionsInstance.matchesRule()
      let matchResult = permissionsInstance.matchesRule(rule, args, metadata);

      if (matchResult && matchResult.matches === false)
        continue;

      if (rule.effect === 'deny')
        throw new PermissionDeniedError(featureName, 'explicit deny rule');

      if (rule.effect === 'allow')
        return false;
    }

    // No match: permissive auto-allows, all others default deny
    if (riskLevel === 'permissive')
      return false;

    return true;
  }

  // ---------------------------------------------------------------------------
  // createRule — creates a new permission rule
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
      let keystore = this._getKeystore();
      if (keystore) {
        let fingerprintData = `${data.organizationID}:${data.featureName}:${data.effect}:${data.scope}`;
        data.fingerprint    = keystore.fingerprint(fingerprintData, ruleData.userKey);
      }
    }

    // Workaround: Mythix ORM's PermissionRule.create() silently drops
    // `createdBy` from the INSERT (possibly a field resolution bug).
    // Use new PermissionRule().save() with explicit data assignment.
    let { default: XID } = await import('xid-js');
    let rule      = new PermissionRule();
    rule.id             = `prm_${XID.next()}`;
    rule.organizationID = data.organizationID;
    rule.featureName    = data.featureName;
    rule.effect         = data.effect;
    rule.scope          = data.scope || 'global';
    rule.scopeID        = data.scopeID || null;
    rule.metadata       = data.metadata || null;
    rule.priority       = data.priority || 0;
    rule.createdBy      = data.createdBy;
    rule.fingerprint    = data.fingerprint || null;
    rule.expiresAt      = data.expiresAt || null;
    await rule.save();
    return rule;
  }

  // ---------------------------------------------------------------------------
  // deleteRule — deletes a rule by ID
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

    if (options.riskLevel) {
      resolved = options.riskLevel;
    } else {
      let agent  = options.agent;
      let config = (agent && typeof agent.getConfig === 'function') ? await agent.getConfig() : null;

      if (config && config.riskLevel) {
        resolved = config.riskLevel;
      } else {
        let user     = options.user;
        let settings = (user && typeof user.getSettings === 'function') ? await user.getSettings() : null;

        if (settings && settings.riskLevel)
          resolved = settings.riskLevel;
        else
          resolved = 'strict';
      }
    }

    // Backward compat: 'medium' -> 'normal'
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

  _filterByScopeWithAncestry(rules, currentScope, currentScopeID, ancestorSessionIDs) {
    if (!currentScope)
      return rules;

    let currentIndex = SCOPE_HIERARCHY.indexOf(currentScope);
    if (currentIndex < 0)
      return rules;

    let allowedScopes = SCOPE_HIERARCHY.slice(currentIndex);

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

        // No scopeID on rule — applies to all sessions
        return true;
      }

      // For frame-scoped rules, scopeID must match exactly
      if (ruleScope === 'frame') {
        if (rule.scopeID && currentScopeID)
          return rule.scopeID === currentScopeID;

        return true;
      }

      return true;
    });
  }

  _parseMetadata(rule) {
    if (!rule.metadata)
      return {};

    if (typeof rule.metadata === 'string') {
      try {
        return JSON.parse(rule.metadata);
      } catch (_error) {
        return {};
      }
    }

    return rule.metadata;
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
