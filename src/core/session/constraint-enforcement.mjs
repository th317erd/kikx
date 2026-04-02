'use strict';

import XID from 'xid-js';

// =============================================================================
// Session Constraint Enforcement
// =============================================================================

/**
 * @param {string} prefix
 * @returns {string}
 */
function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

/**
 * Wires constraint enforcement onto a FrameManager.
 *
 * @param {object} frameManager - The FrameManager to enforce constraints on.
 * @param {object} [options]
 * @param {number|null} [options.maxInteractions] - Max agent-authored commits (null = unlimited).
 * @param {Date|null} [options.endsAt] - Deadline (null = no deadline).
 * @param {((event: { constraint: string, reason: string }) => void)|null} [options.onConstrained] - Callback on first violation.
 * @returns {Function} The commitValidator function (for testing/inspection).
 */
export function createConstraintEnforcer(frameManager, options = {}) {
  let maxInteractions = (options.maxInteractions !== undefined) ? options.maxInteractions : null;
  let endsAt          = (options.endsAt !== undefined) ? options.endsAt : null;
  let onConstrained   = options.onConstrained || null;
  /** @type {boolean} */
  let constrained     = false;

  /** @type {string|null} */
  let pendingConstraint = null;
  /** @type {string|null} */
  let pendingReason     = null;

  /**
   * @param {import('../types').Commit} commit
   * @param {import('../types').FrameData[]} _frames
   * @param {{ authorType: string }} actorContext
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function commitValidator(commit, _frames, actorContext) {
    if (actorContext.authorType === 'system')
      return { allowed: true };

    if (endsAt != null) {
      let deadline = (endsAt instanceof Date) ? endsAt.getTime() : new Date(endsAt).getTime();

      if (Date.now() >= deadline) {
        let reason = `Session expired: endsAt deadline (${new Date(deadline).toISOString()}) has passed`;

        pendingConstraint = 'endsAt';
        pendingReason     = reason;

        return { allowed: false, reason };
      }
    }

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

    createConstrainedFrame(frameManager, constraint, reason);

    if (onConstrained)
      onConstrained({ constraint, reason });
  });

  frameManager._commitValidator = commitValidator;

  return commitValidator;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts the number of agent-authored commits in the FrameManager's commit log.
 * @param {object} frameManager
 * @returns {number}
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
 * @param {object} frameManager
 * @param {string} constraint
 * @param {string} reason
 * @returns {void}
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
