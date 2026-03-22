'use strict';

// =============================================================================
// PermissionRequiredError
// =============================================================================
// Thrown when a tool call needs user approval before execution.
// Carries structured context for the permission dialog UI.
// All user-facing strings are locale keys with interpolation params.
// =============================================================================

export class PermissionRequiredError extends Error {
  constructor(featureName, { title, titleParams, description, details } = {}) {
    super(title || `Permission required: ${featureName}`);

    this.name        = 'PermissionRequiredError';
    this.featureName = featureName || '';
    this.title       = title || null;
    this.titleParams = titleParams || null;
    this.description = description || null;
    this.details     = details || [];
  }
}
