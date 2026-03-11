'use strict';

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
// =============================================================================

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
}
