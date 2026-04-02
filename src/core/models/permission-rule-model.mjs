'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// PermissionRule
// =============================================================================
// Permission rules that control whether tool calls need approval.
// Feature names use pluginID:toolName format (e.g. 'shell:execute').
// Rules are evaluated by priority (descending), first match wins.
// =============================================================================

/**
 * PermissionRule model — controls tool-call approval via allow/deny rules.
 * @see {import('../types').PermissionRule}
 */
export class PermissionRule extends ModelBase {
  /** @type {number} */
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'prm_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    /** @type {string} */
    organizationID: {
      type:      Types.FOREIGN_KEY('Organization:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    // pluginID:toolName format, e.g. 'shell:execute', 'websearch:fetch'
    /** @type {string} */
    featureName: {
      type:      Types.STRING(256),
      allowNull: false,
      index:     true,
    },
    // 'allow' or 'deny'
    /** @type {'allow' | 'deny'} */
    effect: {
      type:      Types.STRING(16),
      allowNull: false,
    },
    // 'global', 'session', or 'frame'
    /** @type {'global' | 'session' | 'frame'} */
    scope: {
      type:         Types.STRING(32),
      allowNull:    false,
      defaultValue: 'global',
    },
    // Session or frame ID when scope is 'session' or 'frame'
    /** @type {string | null} */
    scopeID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    // JSON blob for plugin-specific data (e.g. allowed commands for shell)
    /** @type {string | null} */
    metadata: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Higher = evaluated first
    /** @type {number} */
    priority: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
      index:        true,
    },
    // User ID of rule creator
    /** @type {string} */
    createdBy: {
      type:      Types.STRING(128),
      allowNull: false,
    },
    // HMAC-SHA256 fingerprint from user key (Step 19)
    /** @type {string | null} */
    fingerprint: {
      type:      Types.STRING(128),
      allowNull: true,
    },
    // Optional expiration
    /** @type {Date | null} */
    expiresAt: {
      type:      Types.DATETIME,
      allowNull: true,
      index:     true,
    },
  };
}
