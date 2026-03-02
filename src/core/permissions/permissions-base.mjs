'use strict';

// =============================================================================
// Permissions Base Class
// =============================================================================
// Base class for plugin-specific permission logic.
// Plugins can subclass this and override matchesRule() to implement
// custom rule matching (e.g., command-level shell permissions).
//
// The PermissionEngine calls matchesRule() during rule evaluation.
// Return { matches: true } if the rule applies, { matches: false } to skip it.
// =============================================================================

export class Permissions {
  constructor(context) {
    this._context = context;
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
