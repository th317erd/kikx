'use strict';

import { PermissionRequiredError } from '../permissions/permission-required-error.mjs';

// =============================================================================
// PluginInterface
// =============================================================================
// Base class for all plugin-provided tools.
// Subclasses override _execute() to implement their behavior.
// Static metadata properties identify the plugin for registry/help.
//
// Permission checking:
//   execute() is framework-owned — it calls _checkPermissions() before
//   _execute(). Tools customize via getPermissionsClass() (existing pattern).
//   Base class provides deny-by-default. Plugin authors who do nothing are safe.
// =============================================================================

export class PluginInterface {
  // Static metadata — override in subclasses
  static pluginID     = null;
  static featureName  = null;
  static displayName  = null;
  static description  = null;
  static icon         = null;
  static version      = '1.0.0';
  static riskLevel    = 'high'; // 'none', 'low', 'high', or 'critical'
  static inputSchema  = null;   // JSON Schema for tool input parameters

  constructor(context) {
    this._context = context;
  }

  // ---------------------------------------------------------------------------
  // Public API — framework-owned wrapper (never override)
  // ---------------------------------------------------------------------------

  async execute(params) {
    this._params = params;

    await this._checkPermissions(params);
    return await this._execute(params);
  }

  // ---------------------------------------------------------------------------
  // Workhorse method — override in subclasses
  // ---------------------------------------------------------------------------

  async _execute(params) {
    throw new Error(`${this.constructor.name}._execute() not implemented`);
  }

  // ---------------------------------------------------------------------------
  // Permission checking — delegates to PermissionsClass or base default
  // ---------------------------------------------------------------------------

  async _checkPermissions(params) {
    // riskLevel 'none' — never needs permission
    if (this.constructor.riskLevel === 'none')
      return;

    // Get the PermissionsClass (if tool registers one)
    let PermissionsClass = (typeof this.getPermissionsClass === 'function')
      ? this.getPermissionsClass()
      : null;

    if (PermissionsClass) {
      let permissions = new PermissionsClass(this._context);
      let result = await permissions.checkPermission(this._featureName(), params, this._permissionOptions(params));

      if (result === false)
        return; // Approved by custom class

      if (result === true) {
        // Custom class says needs approval but didn't provide rich context
        throw this._defaultPermissionError(params);
      }

      // result === null → defer to base default (fall through)
    }

    // Base default: check PermissionEngine rules
    await this._checkPermissionEngine(params);
  }

  // ---------------------------------------------------------------------------
  // Base default: PermissionEngine rule check
  // ---------------------------------------------------------------------------

  async _checkPermissionEngine(params) {
    let permissionEngine = this._context.getProperty('permissionEngine');
    if (!permissionEngine)
      return; // No engine = allow (development mode)

    let needsApproval = await permissionEngine.checkPermission(
      this._featureName(), params, this._permissionOptions(params),
    );

    if (!needsApproval)
      return; // Approved by rule

    throw this._defaultPermissionError(params);
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  _featureName() {
    let pluginID    = this.constructor.pluginID || 'unknown';
    let featureName = this.constructor.featureName || 'unknown';
    return `${pluginID}:${featureName}`;
  }

  _permissionOptions(params) {
    return {
      organizationID: params?._agent?.organizationID || null,
      scope:          'session',
      scopeID:        params?._sessionID || null,
      toolClass:      this.constructor,
      agent:          params?._agent || null,
    };
  }

  _defaultPermissionError(params) {
    return new PermissionRequiredError(this._featureName(), {
      title:       this._featureName(),
      description: null,
      details:     this._formatDefaultDetails(params),
    });
  }

  _formatDefaultDetails(params) {
    if (!params || typeof params !== 'object')
      return [];

    let details = [];
    let keys = Object.keys(params);

    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      if (key.startsWith('_'))
        continue;

      let value = params[key];

      if (value == null)
        continue;

      if (typeof value === 'object')
        value = JSON.stringify(value);

      value = String(value);

      if (value.length > 200)
        value = value.slice(0, 200) + '...';

      details.push({ label: key, value });
    }

    return details;
  }

  // ---------------------------------------------------------------------------
  // Help index registration
  // ---------------------------------------------------------------------------

  getHelp() {
    return {
      name:        `${this.constructor.pluginID}:${this.constructor.featureName}`,
      displayName: this.constructor.displayName,
      description: this.constructor.description,
      icon:        this.constructor.icon,
    };
  }

  // ---------------------------------------------------------------------------
  // Permission matching — override point for advanced permission logic
  // ---------------------------------------------------------------------------

  getPermissionsClass() {
    return null;
  }
}
