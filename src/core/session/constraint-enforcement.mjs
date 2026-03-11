'use strict';

import XID from 'xid-js';

// =============================================================================
// Session Constraint Enforcement
// =============================================================================
// Enforces `maxInteractions` and `endsAt` constraints at the commit level
// via the FrameManager's commitValidator hook.
//
// - Only agent-authored commits count toward `maxInteractions`.
// - System-authored commits always pass (needed for the session-constrained
//   system frame itself).
// - When a constraint is hit, a `session-constrained` system frame is created
//   and the `onConstrained` callback is invoked (for archiving, etc.).
// - The enforcer fires `onConstrained` only once — subsequent rejections
//   are silent (the session is already constrained).
//
// IMPORTANT: The constrained frame and callback are triggered via a
// `commit:rejected` listener, NOT from inside the validator itself.
// This avoids re-entrancy issues with the FrameManager's snapshot/rollback
// mechanism (calling merge() inside a validator would be rolled back).
// =============================================================================

/**
 * Wires constraint enforcement onto a FrameManager.
 *
 * @param {FrameManager} frameManager  The FrameManager to enforce constraints on.
 * @param {object}       options
 * @param {number|null}  options.maxInteractions  Max agent-authored commits (null = unlimited).
 * @param {Date|null}    options.endsAt           Deadline (null = no deadline).
 * @param {Function|null} options.onConstrained   Callback invoked on first violation.
 *                                                Receives { constraint, reason }.
 * @returns {Function}   The commitValidator function (for testing/inspection).
 */
export function createConstraintEnforcer(frameManager, options = {}) {
  let maxInteractions = (options.maxInteractions !== undefined) ? options.maxInteractions : null;
  let endsAt          = (options.endsAt !== undefined) ? options.endsAt : null;
  let onConstrained   = options.onConstrained || null;
  let constrained     = false;

  // Track which constraint was hit so the rejection listener can act on it.
  let pendingConstraint = null;
  let pendingReason     = null;

  function commitValidator(commit, _frames, actorContext) {
    // System-authored commits always pass — needed for the session-constrained
    // frame itself and other system bookkeeping.
    if (actorContext.authorType === 'system')
      return { allowed: true };

    // Check endsAt first (time-based constraints take priority since they
    // apply to all non-system author types).
    if (endsAt != null) {
      let deadline = (endsAt instanceof Date) ? endsAt.getTime() : new Date(endsAt).getTime();

      if (Date.now() >= deadline) {
        let reason = `Session expired: endsAt deadline (${new Date(deadline).toISOString()}) has passed`;

        pendingConstraint = 'endsAt';
        pendingReason     = reason;

        return { allowed: false, reason };
      }
    }

    // Check maxInteractions (only for agent-authored commits).
    if (maxInteractions != null && actorContext.authorType === 'agent') {
      let agentCommitCount = countAgentCommits(frameManager);

      if (agentCommitCount >= maxInteractions) {
        let reason = `Session constrained: maxInteractions limit (${maxInteractions}) reached (${agentCommitCount} agent commits)`;

        pendingConstraint = 'maxInteractions';
        pendingReason     = reason;

        return { allowed: false, reason };
      }
    }

    return { allowed: true };
  }

  // Listen for commit:rejected events to handle side effects AFTER the
  // rollback completes. This avoids the re-entrancy problem.
  frameManager.on('commit:rejected', () => {
    if (!pendingConstraint)
      return;

    if (constrained) {
      pendingConstraint = null;
      pendingReason     = null;
      return;
    }

    constrained = true;

    let constraint = pendingConstraint;
    let reason     = pendingReason;

    pendingConstraint = null;
    pendingReason     = null;

    // Create the session-constrained system frame (system commits bypass validator)
    createConstrainedFrame(frameManager, constraint, reason);

    if (onConstrained)
      onConstrained({ constraint, reason });
  });

  // Wire the validator onto the FrameManager
  frameManager._commitValidator = commitValidator;

  return commitValidator;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts the number of agent-authored commits in the FrameManager's commit log.
 */
function countAgentCommits(frameManager) {
  let commits = frameManager.getCommits(0, Infinity);
  let count   = 0;

  for (let i = 0; i < commits.length; i++) {
    if (commits[i].authorType === 'agent')
      count++;
  }

  return count;
}

/**
 * Creates a `session-constrained` system frame in the FrameManager.
 * This is merged as a system-authored commit, which bypasses constraint checks.
 */
function createConstrainedFrame(frameManager, constraint, reason) {
  frameManager.merge(
    [{
      id:         `frm_${XID.next()}`,
      type:       'session-constrained',
      content:    { constraint, reason },
      timestamp:  Date.now(),
      authorType: 'system',
      authorID:   null,
      hidden:     false,
      deleted:    false,
      processed:  false,
    }],
    { authorType: 'system' },
  );
}
