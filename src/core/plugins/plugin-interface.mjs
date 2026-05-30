'use strict';

import { PermissionRequiredError } from '../permissions/permission-required-error.mjs';

const PERMISSION_TIMEOUT_MS = 10000;

export class PluginInterface {
  static pluginID = 'unknown';
  static featureName = 'unknown';
  static displayName = null;
  static description = null;
  static version = '1.0.0';
  static riskLevel = 'high';
  static inputSchema = null;

  constructor(context = {}) {
    this.context = context;
    this.params = null;
  }

  async execute(params = {}) {
    this.params = params;

    await Promise.race([
      this.checkPermissions(params),
      timeout(PERMISSION_TIMEOUT_MS, 'Permission check timed out after 10000ms'),
    ]);

    return await this._execute(params);
  }

  async _execute() {
    throw new Error(`${this.constructor.name}._execute() is not implemented`);
  }

  async checkPermissions(params = {}) {
    if (this.constructor.riskLevel === 'none')
      return;

    let permissions = this.getPermissionsBoundary();
    if (!permissions)
      throw this.createPermissionRequest(params);

    let result = await permissions.check({
      featureName: this.featureName(),
      params,
      tool: this,
      context: this.context,
    });

    if (result === true || result?.allowed === true)
      return;

    if (result?.denied)
      throw new Error(result.reason || `Permission denied for ${this.featureName()}`);

    throw this.createPermissionRequest(params, result?.request);
  }

  getPermissionsBoundary() {
    if (this.context?.permissions)
      return this.context.permissions;

    if (typeof this.context?.require === 'function' && this.context.has?.('permissions'))
      return this.context.require('permissions');

    return null;
  }

  createPermissionRequest(params, request = null) {
    return new PermissionRequiredError(this.featureName(), {
      details: this.formatPermissionDetails(params),
      request,
    });
  }

  featureName() {
    return `${this.constructor.pluginID || 'unknown'}:${this.constructor.featureName || 'unknown'}`;
  }

  formatPermissionDetails(params) {
    if (!params || typeof params !== 'object')
      return [];

    let details = [];

    for (let key of Object.keys(params)) {
      if (key.startsWith('_'))
        continue;

      let value = params[key];
      if (value == null)
        continue;

      if (typeof value === 'object')
        value = JSON.stringify(value);

      value = String(value);
      if (value.length > 200)
        value = `${value.slice(0, 200)}...`;

      details.push({ label: key, value });
    }

    return details;
  }
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms).unref?.();
  });
}

