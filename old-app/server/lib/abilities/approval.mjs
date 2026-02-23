'use strict';

// ============================================================================
// Ability Approval System
// ============================================================================
// Handles permission checking and approval requests for ability execution.

import { randomUUID, createHash } from 'crypto';
import { getDatabase } from '../../database.mjs';
import { broadcastToSession } from '../websocket.mjs';
import { audit, AuditEvent } from '../audit.mjs';

// In-memory pending approvals (executionId -> resolver + security context)
const pendingApprovals = new Map();

/**
 * Generate a hash of the approval request for replay prevention.
 * The hash covers the ability name and serialized parameters.
 *
 * @param {string} abilityName - Ability name
 * @param {Object} params - Execution parameters
 * @returns {string} SHA-256 hex hash
 */
function generateRequestHash(abilityName, params) {
  let data = JSON.stringify({ ability: abilityName, params });
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Check if an ability requires approval before execution.
 *
 * @param {Object} ability - The ability to check
 * @param {Object} context - Execution context
 * @param {number} context.userId - User ID
 * @param {number} context.sessionId - Session ID
 * @returns {Promise<boolean>} True if approval is required
 */
export async function checkApprovalRequired(ability, context) {
  // Check ability's permission settings
  let { permissions } = ability;

  // Auto-approve if explicitly set
  if (permissions.autoApprove)
    return false;

  // Check policy
  switch (permissions.autoApprovePolicy) {
    case 'always':
      return false;

    case 'never':
      return true;

    case 'session':
      // Check if already approved for this session
      return !hasSessionApproval(context.sessionId, ability.name);

    case 'ask':
    default:
      return true;
  }
}

/**
 * Check if an ability has session-scoped approval.
 *
 * @param {number} sessionId - Session ID
 * @param {string} abilityName - Ability name
 * @returns {boolean} True if approved for session
 */
export function hasSessionApproval(sessionId, abilityName) {
  if (!sessionId) return false;

  let db = getDatabase();

  let row = db.prepare(`
    SELECT 1 FROM session_approvals
    WHERE session_id = ? AND ability_name = ?
  `).get(sessionId, abilityName);

  return !!row;
}

/**
 * Grant session-scoped approval for an ability.
 *
 * @param {number} sessionId - Session ID
 * @param {string} abilityName - Ability name
 */
export function grantSessionApproval(sessionId, abilityName) {
  if (!sessionId) return;

  let db = getDatabase();

  db.prepare(`
    INSERT OR IGNORE INTO session_approvals (session_id, ability_name)
    VALUES (?, ?)
  `).run(sessionId, abilityName);
}

/**
 * Revoke session-scoped approval for an ability.
 *
 * @param {number} sessionId - Session ID
 * @param {string} abilityName - Ability name
 */
export function revokeSessionApproval(sessionId, abilityName) {
  if (!sessionId) return;

  let db = getDatabase();

  db.prepare(`
    DELETE FROM session_approvals
    WHERE session_id = ? AND ability_name = ?
  `).run(sessionId, abilityName);
}

/**
 * Request approval from the user.
 *
 * @param {Object} ability - The ability requesting approval
 * @param {Object} params - Execution parameters
 * @param {Object} context - Execution context
 * @param {number} [timeout=0] - Timeout in ms (0 = wait forever)
 * @returns {Promise<{status: string, reason?: string}>} Approval result
 */
export async function requestApproval(ability, params, context, timeout = 0) {
  let executionId  = randomUUID();
  let requestHash  = generateRequestHash(ability.name, params);
  let db           = getDatabase();

  // Store pending approval in database
  db.prepare(`
    INSERT INTO ability_approvals (
      user_id, session_id, ability_name, execution_id,
      status, request_data
    ) VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(
    context.userId,
    context.sessionId || null,
    ability.name,
    executionId,
    JSON.stringify(params)
  );

  // Broadcast approval request to all session participants via WebSocket
  broadcastToSession(context.sessionId, {
    type:        'ability_approval_request',
    executionId: executionId,
    requestHash: requestHash,
    abilityName: ability.name,
    abilityType: ability.type,
    description: ability.description,
    category:    ability.category,
    dangerLevel: ability.permissions?.dangerLevel || 'safe',
    params:      params,
    sessionId:   context.sessionId,
  });

  // Wait for response
  return new Promise((resolve) => {
    pendingApprovals.set(executionId, {
      resolve,
      ability,
      context,
      userId:      context.userId,
      agentId:     context.agent?.id || null,
      requestHash: requestHash,
    });

    // Set timeout if specified
    if (timeout > 0) {
      setTimeout(() => {
        if (pendingApprovals.has(executionId)) {
          pendingApprovals.delete(executionId);

          // Update database status
          db.prepare(`
            UPDATE ability_approvals
            SET status = 'timeout', resolved_at = CURRENT_TIMESTAMP
            WHERE execution_id = ?
          `).run(executionId);

          resolve({ status: 'timeout', reason: 'Approval request timed out' });
        }
      }, timeout);
    }
  });
}

/**
 * Handle an approval response from the user.
 *
 * Security hardening:
 * - Verifies the responding user owns the pending approval
 * - Validates request hash to prevent replay attacks
 * - Prevents duplicate resolution (race condition guard)
 *
 * @param {string} executionId - The execution ID
 * @param {boolean} approved - Whether the request was approved
 * @param {string} [reason] - Optional reason for denial
 * @param {boolean} [rememberForSession=false] - Remember approval for session
 * @param {Object} [securityContext] - Security context from WebSocket
 * @param {number} [securityContext.userId] - Authenticated user ID
 * @param {string} [securityContext.requestHash] - Request hash for replay prevention
 * @returns {{success: boolean, error?: string}} Result of the approval handling
 */
export function handleApprovalResponse(executionId, approved, reason, rememberForSession = false, securityContext = {}) {
  let pending = pendingApprovals.get(executionId);

  if (!pending)
    return { success: false, error: 'Unknown or already resolved execution' };

  // Verify user ownership: the approving user must match the requesting user
  if (securityContext.userId && pending.userId && securityContext.userId !== pending.userId) {
    console.warn(`[Security] Approval ownership mismatch: user ${securityContext.userId} tried to approve execution owned by user ${pending.userId}`);
    return { success: false, error: 'Not authorized to approve this execution' };
  }

  // Verify request hash: prevent replay of approval for different command
  if (securityContext.requestHash && pending.requestHash && securityContext.requestHash !== pending.requestHash) {
    console.warn(`[Security] Request hash mismatch for execution ${executionId}`);
    return { success: false, error: 'Request hash mismatch — possible replay attack' };
  }

  // Self-approval prevention: agents cannot approve their own actions
  if (securityContext.agentId && pending.agentId && securityContext.agentId === pending.agentId) {
    console.warn(`[Security] Self-approval blocked: agent ${securityContext.agentId} tried to approve its own action (execution ${executionId})`);
    return { success: false, error: 'Agents cannot approve their own actions' };
  }

  // Race condition guard: atomically remove from pending
  pendingApprovals.delete(executionId);

  let db     = getDatabase();
  let status = (approved) ? 'approved' : 'denied';

  // Update database
  db.prepare(`
    UPDATE ability_approvals
    SET status = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(status, executionId);

  // Audit the approval decision
  let auditEvent = (approved) ? AuditEvent.APPROVAL_GRANT : AuditEvent.APPROVAL_DENY;
  audit(auditEvent, {
    userId:      pending.userId,
    agentId:     pending.agentId,
    sessionId:   pending.context.sessionId || null,
    executionId: executionId,
    abilityName: pending.ability.name,
    reason:      reason || null,
  });

  // Grant session approval if requested
  if (approved && rememberForSession && pending.context.sessionId) {
    grantSessionApproval(pending.context.sessionId, pending.ability.name);
  }

  // Resolve the promise
  pending.resolve({ status, reason });

  return { success: true };
}

/**
 * Cancel a pending approval request.
 *
 * @param {string} executionId - The execution ID
 */
export function cancelApproval(executionId) {
  let pending = pendingApprovals.get(executionId);

  if (!pending)
    return;

  pendingApprovals.delete(executionId);

  let db = getDatabase();

  db.prepare(`
    UPDATE ability_approvals
    SET status = 'denied', resolved_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(executionId);

  pending.resolve({ status: 'denied', reason: 'Cancelled' });
}

/**
 * Get all pending approvals for a user.
 *
 * @param {number} userId - User ID
 * @returns {Array} Pending approval records
 */
export function getPendingApprovals(userId) {
  let db = getDatabase();

  return db.prepare(`
    SELECT execution_id, ability_name, request_data, created_at
    FROM ability_approvals
    WHERE user_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(userId);
}

/**
 * Get approval history for a user.
 *
 * @param {number} userId - User ID
 * @param {number} [limit=50] - Maximum records to return
 * @returns {Array} Approval records
 */
export function getApprovalHistory(userId, limit = 50) {
  let db = getDatabase();

  return db.prepare(`
    SELECT execution_id, ability_name, status, request_data, created_at, resolved_at
    FROM ability_approvals
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

/**
 * Get a specific pending approval by execution ID (for testing/introspection).
 *
 * @param {string} executionId - The execution ID
 * @returns {Object|undefined} Pending approval entry
 */
export function getPendingApproval(executionId) {
  return pendingApprovals.get(executionId);
}

/**
 * Inject a pending approval for testing.
 * @private
 */
export function _addPendingApproval(executionId, entry) {
  pendingApprovals.set(executionId, entry);
}

export { generateRequestHash };

export default {
  checkApprovalRequired,
  hasSessionApproval,
  grantSessionApproval,
  revokeSessionApproval,
  requestApproval,
  handleApprovalResponse,
  cancelApproval,
  getPendingApprovals,
  getPendingApproval,
  getApprovalHistory,
  generateRequestHash,
};
