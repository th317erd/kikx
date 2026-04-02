'use strict';

// =============================================================================
// PermissionRequiredError
// =============================================================================
// Thrown when a tool call needs user approval before execution.
// Carries structured context for the permission dialog UI.
// All user-facing strings are locale keys with interpolation params.
// =============================================================================

export class PermissionRequiredError extends Error {
  /**
   * @param {string} featureName
   * @param {object} [options]
   * @param {string|null} [options.title]
   * @param {Record<string, string>|null} [options.titleParams]
   * @param {string|null} [options.description]
   * @param {Array<{ label: string, value: string }>} [options.details]
   */
  constructor(featureName, { title, titleParams, description, details } = {}) {
    super(title || `Permission required: ${featureName}`);

    /** @type {string} */
    this.name        = 'PermissionRequiredError';
    /** @type {string} */
    this.featureName = featureName || '';
    /** @type {string|null} */
    this.title       = title || null;
    /** @type {Record<string, string>|null} */
    this.titleParams = titleParams || null;
    /** @type {string|null} */
    this.description = description || null;
    /** @type {Array<{ label: string, value: string }>} */
    this.details     = details || [];
  }
}
