'use strict';

export class PermissionRequiredError extends Error {
  constructor(featureName, options = {}) {
    super(options.message || `Permission required for ${featureName}`);
    this.name = 'PermissionRequiredError';
    this.featureName = featureName;
    this.title = options.title || 'permission.defaultTitle';
    this.titleParams = options.titleParams || {};
    this.description = options.description || 'permission.defaultDescription';
    this.details = Array.isArray(options.details) ? options.details : [];
    this.request = options.request || null;
  }
}

