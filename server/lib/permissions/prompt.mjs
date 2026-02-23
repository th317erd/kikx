'use strict';

// ============================================================================
// Permission Prompt System
// ============================================================================
// When the permission engine returns Action.PROMPT, this module generates
// an hml-prompt form, broadcasts it as a system message to the channel,
// and awaits the user's response. On submission, it creates a permission
// rule and resolves the pending promise so the blocked action can proceed.
//
// Flow:
//   1. Permission engine returns { action: 'prompt' }
//   2. requestPermissionPrompt() creates a system message with <hml-prompt>
//   3. User fills in the prompt and clicks Submit
//   4. Answer flows through update_prompt → handlePermissionResponse()
//   5. Permission rule created, pending promise resolved
//   6. Blocked action proceeds or is denied

import { createHash } from 'node:crypto';
import { createSystemMessageFrame, createAndBroadcastFrame } from '../frames/broadcast.mjs';
import { FrameType, AuthorType } from '../frames/index.mjs';
import { createRule, Action, Scope } from './index.mjs';

// In-memory pending permission prompts (promptId → resolver + context)
const pendingPermissionPrompts = new Map();

// Prompt ID prefix — used to identify permission prompts in update_prompt
const PERMISSION_PROMPT_PREFIX = 'perm-';

// Default timeout: 5 minutes
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a prompt ID belongs to a permission prompt.
 *
 * @param {string} promptId - The prompt ID to check
 * @returns {boolean} True if this is a permission prompt
 */
export function isPermissionPrompt(promptId) {
  if (!promptId || typeof promptId !== 'string')
    return false;

  return promptId.startsWith(PERMISSION_PROMPT_PREFIX);
}

/**
 * Request permission approval from the user via an hml-prompt form.
 *
 * Creates a system message frame with an hml-prompt containing permission
 * options, broadcasts it to the channel, and returns a Promise that resolves
 * when the user submits an answer.
 *
 * @param {Object} subject  - Permission subject { type, id }
 * @param {Object} resource - Permission resource { type, name }
 * @param {Object} context  - Execution context
 * @param {number} context.sessionId - Session ID
 * @param {number} context.userId    - User ID
 * @param {Object} [context.db]      - Optional database instance
 * @param {number} [timeout]         - Timeout in ms (0 = default 5min)
 * @returns {Promise<{action: string, scope?: string, reason?: string}>}
 */
export async function requestPermissionPrompt(subject, resource, context, timeout = 0, details = null) {
  let effectiveTimeout = timeout || DEFAULT_TIMEOUT;
  let promptId         = generatePromptId();
  let requestHash      = generatePermissionHash(subject, resource);

  // Build descriptive message
  let description  = formatDescription(subject, resource, details);
  let promptMarkup = buildPromptMarkup(promptId, requestHash, description);

  // Create system message frame with the hml-prompt.
  // Uses authorType: SYSTEM so the chat UI shows "System" instead of agent name.
  let frame = createSystemMessageFrame({
    sessionId:    context.sessionId,
    userId:       context.userId,
    content:      promptMarkup,
    hidden:       false,
  });

  // Also create a structured request frame (machine-readable for API consumers)
  let requestFrame = createAndBroadcastFrame({
    sessionId:  context.sessionId,
    userId:     context.userId,
    type:       FrameType.REQUEST,
    authorType: AuthorType.SYSTEM,
    payload: {
      action:        'permission_request',
      promptId:      promptId,
      subject:       subject,
      resource:      resource,
      description:   description,
      details:       details || null,
      options:       ['allow_once', 'allow_session', 'allow_always', 'deny'],
      defaultOption: 'deny',
      status:        'pending',
    },
    targetIds: ['user:' + context.userId],
  }, context.db);

  // Store pending prompt and return a Promise
  return new Promise((resolve) => {
    pendingPermissionPrompts.set(promptId, {
      resolve,
      subject,
      resource,
      context,
      requestHash,
      frameId:        frame.id,
      requestFrameId: requestFrame.id,
    });

    if (effectiveTimeout > 0) {
      setTimeout(() => {
        if (pendingPermissionPrompts.has(promptId)) {
          pendingPermissionPrompts.delete(promptId);
          resolve({ action: Action.DENY, reason: 'Permission prompt timed out' });
        }
      }, effectiveTimeout);
    }
  });
}

/**
 * Handle a permission prompt response from the user.
 *
 * Called by update_prompt when it detects a `perm-*` prompt ID.
 * Creates the appropriate permission rule and resolves the pending promise.
 *
 * @param {string} promptId - The permission prompt ID
 * @param {string} answer   - The user's answer (allow_once, allow_session, allow_always, deny)
 * @returns {{ success: boolean, error?: string }}
 */
export function handlePermissionResponse(promptId, answer) {
  let pending = pendingPermissionPrompts.get(promptId);

  if (!pending)
    return { success: false, error: 'Unknown or already resolved permission prompt' };

  // Atomically remove from pending (prevents duplicate resolution)
  pendingPermissionPrompts.delete(promptId);

  // Map answer to action + scope
  let mapped = mapAnswerToActionScope(answer);

  // Create permission rule if allowing.
  // For ONCE scope, do NOT create a persistent rule — the prompt resolution
  // itself IS the one-time grant.  A persistent 'once' rule would be consumed
  // by the NEXT evaluatePermission() call, not the current one (which already
  // received the answer via the prompt), effectively making "allow once" into
  // "allow twice".
  if (mapped.action === Action.ALLOW && mapped.scope !== Scope.ONCE) {
    try {
      createRule({
        ownerId:      pending.context.userId,
        sessionId:    (mapped.scope === Scope.SESSION) ? pending.context.sessionId : null,
        subjectType:  pending.subject.type,
        subjectId:    pending.subject.id,
        resourceType: pending.resource.type,
        resourceName: pending.resource.name,
        action:       Action.ALLOW,
        scope:        mapped.scope,
        priority:     0,
      }, pending.context.db);
    } catch (error) {
      console.error('[Permissions] Failed to create permission rule:', error.message);
    }
  }

  // Create a structured result frame (machine-readable response)
  if (pending.requestFrameId && pending.context) {
    try {
      createAndBroadcastFrame({
        sessionId:  pending.context.sessionId,
        userId:     pending.context.userId,
        type:       FrameType.RESULT,
        authorType: AuthorType.USER,
        parentId:   pending.requestFrameId,
        payload: {
          action:         'permission_response',
          promptId:       promptId,
          answer:         answer,
          resolvedAction: mapped.action,
          resolvedScope:  mapped.scope,
        },
        targetIds: ['system:permission'],
      }, pending.context.db);
    } catch (error) {
      console.error('[Permissions] Failed to create result frame:', error.message);
    }
  }

  // Resolve the pending promise
  pending.resolve({
    action: mapped.action,
    scope:  mapped.scope,
    reason: answer,
  });

  return { success: true };
}

/**
 * Get a pending permission prompt by ID (for testing/introspection).
 *
 * @param {string} promptId
 * @returns {Object|undefined}
 */
export function getPendingPermissionPrompt(promptId) {
  return pendingPermissionPrompts.get(promptId);
}

/**
 * Cancel a pending permission prompt.
 *
 * @param {string} promptId
 */
export function cancelPermissionPrompt(promptId) {
  let pending = pendingPermissionPrompts.get(promptId);

  if (!pending)
    return;

  pendingPermissionPrompts.delete(promptId);
  pending.resolve({ action: Action.DENY, reason: 'Cancelled' });
}

/**
 * Inject a pending permission prompt (for testing).
 * @private
 */
export function _addPendingPermissionPrompt(promptId, entry) {
  pendingPermissionPrompts.set(promptId, entry);
}

/**
 * Clear all pending permission prompts (for testing).
 * @private
 */
export function _clearPendingPermissionPrompts() {
  pendingPermissionPrompts.clear();
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Generate a unique permission prompt ID.
 * @returns {string}
 */
function generatePromptId() {
  let random = Math.random().toString(36).slice(2, 10);
  let ts     = Date.now().toString(36);
  return `${PERMISSION_PROMPT_PREFIX}${ts}-${random}`;
}

/**
 * Generate a SHA-256 hash of the permission request for integrity.
 *
 * @param {Object} subject
 * @param {Object} resource
 * @returns {string}
 */
function generatePermissionHash(subject, resource) {
  let data = JSON.stringify({ subject, resource });
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Format a human-readable description of the permission request.
 *
 * @param {Object} subject  - { type, id }
 * @param {Object} resource - { type, name }
 * @returns {string}
 */
function formatDescription(subject, resource, details = null) {
  let subjectDesc = subject.name || `${subject.type} #${subject.id}`;

  if (details) {
    if (details.query)
      return `**${subjectDesc}** wants to search the web for "${details.query}"`;
    if (details.url)
      return `**${subjectDesc}** wants to fetch \`${details.url}\``;
    if (details.command)
      return `**${subjectDesc}** wants to run command: \`${details.command}${details.args ? ' ' + details.args : ''}\``;
  }

  let resourceDesc = (resource.name)
    ? `\`/${resource.name}\` (${resource.type})`
    : `all ${resource.type}s`;

  return `**${subjectDesc}** wants to execute ${resourceDesc}`;
}

/**
 * Build the hml-prompt markup for the permission prompt.
 *
 * @param {string} promptId
 * @param {string} requestHash
 * @param {string} description
 * @returns {string}
 */
function buildPromptMarkup(promptId, requestHash, description) {
  return [
    `**Permission Required**\n\n${description}\n\n`,
    `<hml-prompt id="${promptId}" type="radio">`,
    `<option value="allow_once">Allow this once</option>`,
    `<option value="allow_session">Allow for this session</option>`,
    `<option value="allow_always">Always allow</option>`,
    `<option value="deny" selected>Deny</option>`,
    `Grant permission?</hml-prompt>`,
  ].join('');
}

/**
 * Map a user answer to a permission action + scope.
 *
 * @param {string} answer - User's answer (allow_once, allow_session, allow_always, deny)
 * @returns {{ action: string, scope: string }}
 */
function mapAnswerToActionScope(answer) {
  switch (answer) {
    case 'allow_once':
      return { action: Action.ALLOW, scope: Scope.ONCE };

    case 'allow_session':
      return { action: Action.ALLOW, scope: Scope.SESSION };

    case 'allow_always':
      return { action: Action.ALLOW, scope: Scope.PERMANENT };

    case 'deny':
    default:
      return { action: Action.DENY, scope: Scope.ONCE };
  }
}

// ============================================================================
// Permit Bag — request-scoped permission grants
// ============================================================================
// When a user grants "allow once", the grant only resolves the current prompt
// but doesn't create a persistent rule. Within the same HTTP request, if
// both the streaming parser path and the interaction loop path check
// permissions for the same resource, the second check would prompt again.
//
// The permit bag is a request-local Map that records allow_once grants so
// subsequent checks within the same request skip straight to execution.
// It's created at the start of the SSE handler and garbage collected when
// the response ends.

/**
 * Create a new permit bag (request-scoped permission cache).
 * @returns {Map}
 */
export function createPermitBag() {
  return new Map();
}

/**
 * Check if a grant exists in the permit bag.
 *
 * @param {Map|null} permitBag - The permit bag (may be null)
 * @param {Object} subject - { type, id }
 * @param {Object} resource - { type, name }
 * @returns {{ action: string }|null} Grant result or null if no grant
 */
export function checkPermitBag(permitBag, subject, resource) {
  if (!permitBag) return null;
  let key = `${subject.type}:${subject.id}:${resource.type}:${resource.name}`;
  return permitBag.has(key) ? { action: 'ALLOW' } : null;
}

/**
 * Record a grant in the permit bag.
 *
 * @param {Map|null} permitBag - The permit bag (may be null)
 * @param {Object} subject - { type, id }
 * @param {Object} resource - { type, name }
 */
export function recordPermitBagGrant(permitBag, subject, resource) {
  if (!permitBag) return;
  let key = `${subject.type}:${subject.id}:${resource.type}:${resource.name}`;
  permitBag.set(key, 'ALLOW');
}

export { PERMISSION_PROMPT_PREFIX, generatePermissionHash };

export default {
  isPermissionPrompt,
  requestPermissionPrompt,
  handlePermissionResponse,
  cancelPermissionPrompt,
  getPendingPermissionPrompt,
  createPermitBag,
  checkPermitBag,
  recordPermitBagGrant,
};
