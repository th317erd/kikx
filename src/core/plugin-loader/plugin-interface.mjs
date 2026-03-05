'use strict';

// =============================================================================
// PluginInterface
// =============================================================================
// Base class for all plugin-provided tools.
// Subclasses override _execute() to implement their behavior.
// Static metadata properties identify the plugin for registry/help.
// =============================================================================

export class PluginInterface {
  // Static metadata — override in subclasses
  static pluginId     = null;
  static featureName  = null;
  static displayName  = null;
  static description  = null;
  static icon         = null;
  static version      = '1.0.0';
  static riskLevel    = 'high'; // 'low', 'high', or 'critical'
  static inputSchema  = null;   // JSON Schema for tool input parameters

  constructor(context) {
    this._context = context;
  }

  // ---------------------------------------------------------------------------
  // Public API — wrapper method
  // ---------------------------------------------------------------------------

  async execute(params) {
    return await this._execute(params);
  }

  // ---------------------------------------------------------------------------
  // Workhorse method — override in subclasses
  // ---------------------------------------------------------------------------

  async _execute(params) {
    throw new Error(`${this.constructor.name}._execute() not implemented`);
  }

  // ---------------------------------------------------------------------------
  // Help index registration
  // ---------------------------------------------------------------------------

  getHelp() {
    return {
      name:        `${this.constructor.pluginId}:${this.constructor.featureName}`,
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
