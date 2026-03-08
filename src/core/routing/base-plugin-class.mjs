'use strict';

// =============================================================================
// BasePluginClass — Base class for all routing plugins
// =============================================================================
// Fresh instances are created per routing cycle (not long-lived singletons).
// Subclasses override process(), onChange(), and checkPermission() to implement
// plugin-specific behavior within the middleware chain.
//
// Lifecycle:
//   1. Router creates new instance with context
//   2. Router calls process(next, done)
//   3. Plugin does work, then calls next(ctx) to continue or done(ctx) to stop
//   4. Instance is discarded after the routing cycle completes
// =============================================================================

export class BasePluginClass {
  constructor(context) {
    this._context = context;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  // Returns the context object passed to the constructor.
  get context() {
    return this._context;
  }

  // Returns the logger from context, falling back to the global console.
  get logger() {
    return this._context.logger || console;
  }

  // ---------------------------------------------------------------------------
  // Primary handler — override in subclasses
  // ---------------------------------------------------------------------------

  // Called by the router's middleware chain.
  // `next(ctx)` continues to the next plugin in the chain.
  // `done(ctx)` stops the chain immediately.
  // Default behavior: pass through to the next plugin.
  async process(next, done) {
    return await next(this._context);
  }

  // ---------------------------------------------------------------------------
  // Change processing
  // ---------------------------------------------------------------------------

  // Iterates context.changes and calls onChange() for each entry.
  // Handles missing or non-array changes gracefully (no-op).
  processChanges() {
    let changes = this._context.changes;
    if (!changes || !Array.isArray(changes))
      return;

    for (let i = 0; i < changes.length; i++) {
      let change = changes[i];
      this.onChange(change.propName, change.previousValue, change.newValue);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-property change handler — override in subclasses
  // ---------------------------------------------------------------------------

  // Called by processChanges() for each change entry.
  // Override in subclasses to react to specific property changes.
  // eslint-disable-next-line no-unused-vars
  onChange(propName, previousValue, newValue) {
    // Default: no-op
  }

  // ---------------------------------------------------------------------------
  // Permission check — delegates to PermissionService
  // ---------------------------------------------------------------------------

  // Returns: { approved: true, signature } or { approved: false, reason }
  // If no PermissionService is available on context, defaults to approved.
  async checkPermission(toolName, params) {
    let permissionService = this._context.permissionService || null;
    if (!permissionService)
      return { approved: true };

    let options = {
      organizationID: this._context.organizationID || null,
      sessionID:      (this._context.session && this._context.session.id) || null,
    };

    try {
      let result = await permissionService.check(toolName, params, options);

      if (result.decision === 'allow')
        return { approved: true, signature: result.signature };

      return { approved: false, reason: 'needs-approval' };
    } catch (error) {
      if (error.name === 'PermissionDeniedError')
        return { approved: false, reason: error.reason || 'denied' };

      throw error;
    }
  }
}
