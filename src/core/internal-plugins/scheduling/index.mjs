'use strict';

import { BasePluginClass } from '../../routing/base-plugin-class.mjs';

// =============================================================================
// Scheduling Plugin
// =============================================================================
// Routing-based replacement for SchedulerOrchestrator. Registers for
// user-message frames via the FrameRouter and triggers multi-agent
// scheduling when a user-authored commit arrives.
//
// The scheduling plugin resolves the SessionScheduler lazily from the
// KikxCore context at process time (not setup time), because the scheduler
// is registered on context AFTER plugins load.
// =============================================================================

export function setup({ registerSelector, context }) {
  class SchedulingPlugin extends BasePluginClass {
    async process(next, done) {
      // Resolve scheduler lazily — it may not exist at setup time
      let sessionScheduler = context.getProperty('sessionScheduler');
      if (!sessionScheduler)
        return await next(this.context);

      let commit    = this.context.commit;
      let sessionID = this.context.session && this.context.session.id;

      // Only schedule agents on user-authored commits. Agent and system
      // commits must be ignored to prevent ping-pong loops.
      if (!sessionID || !commit || commit.authorType !== 'user')
        return await next(this.context);

      try {
        let scheduled = await sessionScheduler.onCommit(sessionID, commit);

        if (scheduled && scheduled.length > 0) {
          for (let entry of scheduled)
            sessionScheduler.queueTrigger(sessionID, entry.agentID);
        }
      } catch (err) {
        this.logger.error('SchedulingPlugin: error in onCommit:', err);
      }

      return await next(this.context);
    }
  }

  registerSelector('type:user-message', SchedulingPlugin);
}
