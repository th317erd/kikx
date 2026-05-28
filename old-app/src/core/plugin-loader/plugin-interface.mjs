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
  /** @type {string | null} */
  static pluginID     = null;
  /** @type {string | null} */
  static featureName  = null;
  /** @type {string | null} */
  static displayName  = null;
  /** @type {string | null} */
  static description  = null;
  /** @type {string | null} */
  static icon         = null;
  /** @type {string} */
  static version      = '1.0.0';
  /** @type {'none' | 'low' | 'high' | 'critical'} */
  static riskLevel    = 'high';
  /** @type {import('../types').JSONSchema | null} */
  static inputSchema  = null;

  /**
   * @param {import('../types').CascadingContext & Record<string, any>} context
   */
  constructor(context) {
    /** @type {import('../types').CascadingContext & Record<string, any>} */
    this._context = context;

    /** @type {Record<string, any> | undefined} */
    this._params = undefined;
  }

  // ---------------------------------------------------------------------------
  // Public API — framework-owned wrapper (never override)
  // ---------------------------------------------------------------------------

  /**
   * Framework-owned execute wrapper. Checks permissions then delegates to _execute().
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  async execute(params) {
    this._params = params;

    // Permission check with safety timeout — never hang forever
    await Promise.race([
      this._checkPermissions(params),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Permission check timed out after 10s')), 10000)),
    ]);

    return await this._execute(params);
  }

  // ---------------------------------------------------------------------------
  // Workhorse method — override in subclasses
  // ---------------------------------------------------------------------------

  /**
   * Workhorse method — override in subclasses.
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  async _execute(params) {
    throw new Error(`${this.constructor.name}._execute() not implemented`);
  }

  // ---------------------------------------------------------------------------
  // Permission checking — delegates to PermissionsClass or base default
  // ---------------------------------------------------------------------------

  /**
   * Permission checking — delegates to PermissionsClass or base default.
   * @param {Record<string, any>} params
   * @returns {Promise<void>}
   */
  async _checkPermissions(params) {
    // riskLevel 'none' — never needs permission
    if (this.constructor.riskLevel === 'none')
      return;

    // Get the PermissionsClass (if tool registers one)
    let PermissionsClass = (typeof this.getPermissionsClass === 'function')
      ? this.getPermissionsClass()
      : null;

    // Use tool's PermissionsClass or base Permissions class
    let { Permissions } = await import('../permissions/permissions-base.mjs');
    let PermClass   = PermissionsClass || Permissions;
    let permissions = new PermClass(this._context);

    // First: check custom checkPermission() if the class overrides it
    let customResult = await permissions.checkPermission(
      this._featureName(), params, this._permissionOptions(params),
    );

    if (customResult === false)
      return; // Custom class says approved

    if (customResult === true) {
      // Custom class says needs approval but didn't throw rich error
      throw this._defaultPermissionError(params);
    }

    // customResult === null → defer to evaluate()
    let needsApproval = await permissions.evaluate(
      this._featureName(), params, this._permissionOptions(params),
    );

    if (needsApproval)
      throw this._defaultPermissionError(params);
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  /**
   * Build the fully-qualified feature name.
   * @returns {string}
   */
  _featureName() {
    let pluginID    = this.constructor.pluginID || 'unknown';
    let featureName = this.constructor.featureName || 'unknown';
    return `${pluginID}:${featureName}`;
  }

  /**
   * Build permission options from params.
   * @param {Record<string, any>} params
   * @returns {{ organizationID: string | null; scope: string; scopeID: string | null; toolClass: typeof PluginInterface; agent: import('../types').Agent | null }}
   */
  _permissionOptions(params) {
    return {
      organizationID: params?._agent?.organizationID || null,
      scope:          'session',
      scopeID:        params?._sessionID || null,
      toolClass:      this.constructor,
      agent:          params?._agent || null,
    };
  }

  /**
   * Create a default PermissionRequiredError.
   * @param {Record<string, any>} params
   * @returns {PermissionRequiredError}
   */
  _defaultPermissionError(params) {
    return new PermissionRequiredError(this._featureName(), {
      title:       this._featureName(),
      description: null,
      details:     this._formatDefaultDetails(params),
    });
  }

  /**
   * Format parameter details for permission error display.
   * @param {Record<string, any>} params
   * @returns {Array<{ label: string; value: string }>}
   */
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

  /**
   * Returns help metadata for this tool.
   * @returns {{ name: string; displayName: string | null; description: string | null; icon: string | null }}
   */
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

  /**
   * Override point for advanced permission logic. Return a Permissions subclass or null.
   * @returns {Function | null}
   */
  getPermissionsClass() {
    return null;
  }
}
