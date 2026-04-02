'use strict';

import { BasePluginClass } from '../../routing/base-plugin-class.mjs';

// =============================================================================
// Scheduling Plugin
// =============================================================================
// Triggers multi-agent scheduling when commits arrive. Registered for
// both UserMessage and Message frames so agents see each other's output.
//
// Loop prevention: tracks consecutive agent turns per session. After
// MAX_AGENT_ROUNDS without user input, stops scheduling to prevent
// infinite agent-to-agent chatter.
// =============================================================================

const MAX_AGENT_ROUNDS = 3; // Max consecutive agent turns before stopping

/**
 * @param {(cb: (ctx: { registry: any, context: import('../../types').CascadingContext }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry, context }) => {

    // Track consecutive agent rounds per session (resets on user message)
    let agentRoundCounts = new Map();

    class SchedulingPlugin extends BasePluginClass {
      /**
       * @param {Function} next
       * @param {Function} done
       * @returns {Promise<any>}
       */
      async process(next, done) {
        let sessionScheduler = context.getProperty('sessionScheduler');
        if (!sessionScheduler)
          return await next(this.context);

        let commit    = this.context.commit;
        let sessionID = this.context.session && this.context.session.id;

        if (!sessionID || !commit)
          return await next(this.context);

        // Skip system commits (errors, notifications, etc.)
        if (commit.authorType === 'system')
          return await next(this.context);

        // Track agent rounds for loop prevention
        if (commit.authorType === 'user') {
          // User spoke — reset the counter
          agentRoundCounts.set(sessionID, 0);
        } else if (commit.authorType === 'agent') {
          // Agent spoke — increment counter
          let rounds = (agentRoundCounts.get(sessionID) || 0) + 1;
          agentRoundCounts.set(sessionID, rounds);

          // Too many agent rounds without user input — stop scheduling
          if (rounds > MAX_AGENT_ROUNDS)
            return await next(this.context);

          // Don't schedule the agent that just spoke (it already ran)
          // The scheduler handles this via its "already-active" check,
          // but we also skip if the commit author IS the agent being
          // considered (the scheduler's onCommit already filters this).
        }

        try {
          let scheduled = await sessionScheduler.onCommit(sessionID, commit);

          if (scheduled && scheduled.length > 0) {
            for (let entry of scheduled)
              sessionScheduler.queueTrigger(sessionID, entry.agentID);

            sessionScheduler._triggerNext(sessionID).catch(() => {});
          }
        } catch (err) {
          this.logger.error('SchedulingPlugin: error in onCommit:', err);
        }

        return await next(this.context);
      }
    }

    // Register for BOTH user and agent messages — agents need to see
    // each other's output, not just user messages.
    registry.registerSelector('type:UserMessage', SchedulingPlugin);
    registry.registerSelector('type:Message', SchedulingPlugin);
  });
}
