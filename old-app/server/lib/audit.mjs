'use strict';

// ============================================================================
// Audit Logger
// ============================================================================
// Structured security event logging. Dual output:
//   1. JSON to stdout for log aggregators (ELK, CloudWatch, etc.)
//   2. SQLite audit_logs table for in-app querying
//
// Events logged:
//   - login_success, login_failure
//   - permission_allow, permission_deny, permission_prompt
//   - api_key_create, api_key_revoke, api_key_use
//   - approval_grant, approval_deny

import { getDatabase } from '../database.mjs';

// ============================================================================
// Event Types
// ============================================================================

export const AuditEvent = Object.freeze({
  LOGIN_SUCCESS:    'login_success',
  LOGIN_FAILURE:    'login_failure',
  PERMISSION_ALLOW: 'permission_allow',
  PERMISSION_DENY:  'permission_deny',
  PERMISSION_PROMPT:'permission_prompt',
  API_KEY_CREATE:   'api_key_create',
  API_KEY_REVOKE:   'api_key_revoke',
  API_KEY_USE:      'api_key_use',
  APPROVAL_GRANT:   'approval_grant',
  APPROVAL_DENY:    'approval_deny',
});

// ============================================================================
// Logger
// ============================================================================

// In-memory log buffer for testing — disabled in production
let testLogBuffer = null;

/**
 * Log an audit event.
 *
 * Writes to stdout (JSON) and persists to audit_logs table (best-effort).
 *
 * @param {string} event    - Event type (from AuditEvent)
 * @param {object} details  - Event-specific details
 * @param {object} [database] - Optional DB instance (for testing)
 */
export function audit(event, details = {}, database) {
  let entry = {
    audit:     true,
    event,
    timestamp: new Date().toISOString(),
    ...details,
  };

  // In test mode, push to buffer instead of stdout/DB
  if (testLogBuffer) {
    testLogBuffer.push(entry);
    return;
  }

  // Write to stdout
  console.log(JSON.stringify(entry));

  // Persist to DB (best-effort — never fail the calling operation)
  try {
    let db = database || getDatabase();
    db.prepare(`
      INSERT INTO audit_logs (event_type, user_id, agent_id, session_id, ip_address, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event,
      details.userId || null,
      details.agentId || null,
      details.sessionId || null,
      details.ipAddress || null,
      JSON.stringify(details),
    );
  } catch (_) {
    // Audit logging must never break the caller — silently continue
  }
}

// ============================================================================
// Query Helpers
// ============================================================================

/**
 * Get recent audit log entries.
 *
 * @param {object} [filters]         - Optional filters
 * @param {string} [filters.eventType] - Filter by event type
 * @param {number} [filters.userId]    - Filter by user ID
 * @param {number} [filters.limit]     - Max entries (default 100)
 * @param {object} [database]          - Optional DB instance
 * @returns {Array<{id, timestamp, eventType, userId, agentId, sessionId, ipAddress, details}>}
 */
export function getAuditLogs(filters = {}, database) {
  let db         = database || getDatabase();
  let conditions = [];
  let params     = [];

  if (filters.eventType) {
    conditions.push('event_type = ?');
    params.push(filters.eventType);
  }

  if (filters.userId) {
    conditions.push('user_id = ?');
    params.push(filters.userId);
  }

  let where = (conditions.length > 0)
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  let limit = filters.limit || 100;

  let rows = db.prepare(`
    SELECT id, timestamp, event_type, user_id, agent_id, session_id, ip_address, details
    FROM audit_logs
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map((row) => ({
    id:        row.id,
    timestamp: row.timestamp,
    eventType: row.event_type,
    userId:    row.user_id,
    agentId:   row.agent_id,
    sessionId: row.session_id,
    ipAddress: row.ip_address,
    details:   JSON.parse(row.details || '{}'),
  }));
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Enable test mode — audit entries go to an in-memory buffer.
 * Returns the buffer array.
 *
 * @returns {Array} The log buffer
 */
export function _enableTestMode() {
  testLogBuffer = [];
  return testLogBuffer;
}

/**
 * Disable test mode — audit entries go to stdout.
 */
export function _disableTestMode() {
  testLogBuffer = null;
}

/**
 * Get the current test log buffer.
 *
 * @returns {Array|null}
 */
export function _getTestBuffer() {
  return testLogBuffer;
}

export default {
  audit,
  AuditEvent,
  getAuditLogs,
  _enableTestMode,
  _disableTestMode,
  _getTestBuffer,
};
