'use strict';

import { BasePluginClass } from '../../routing/base-plugin-class.mjs';

// =============================================================================
// Scheduling Plugin
// =============================================================================
// Routing-based replacement for SchedulerOrchestrator. Registers for
// user-message frames via the FrameRouter and triggers multi-agent
// scheduling when a user-authored commit arrives.
//
// The scheduling plugin accesses the SessionScheduler from the KikxCore
// context (captured via closure at setup time). All persistent state
// lives in SessionScheduler — the plugin instance is stateless.
// =============================================================================

export function setup({ registerSelector, context }) {
  let sessionScheduler      = context.getProperty('sessionScheduler');
  let sessionManager        = context.getProperty('sessionManager');
  let discussionOrchestrator = context.getProperty('discussionOrchestrator');

  // If no scheduler exists (e.g., embedded/test mode without multi-agent),
  // skip registration entirely.
  if (!sessionScheduler)
    return;

  class SchedulingPlugin extends BasePluginClass {
    async process(next, done) {
      let commit    = this.context.commit;
      let sessionID = this.context.session && this.context.session.id;

      // Only schedule agents on user-authored commits. Agent and system
      // commits must be ignored to prevent ping-pong loops.
      if (!sessionID || !commit || commit.authorType !== 'user') {
        return await next(this.context);
      }

      try {
        // Check for multi-coordinator discussion
        if (discussionOrchestrator && sessionManager) {
          let coordinators = await sessionManager.getCoordinators(sessionID);

          if (coordinators && coordinators.length >= 2) {
            let coordinatorList = coordinators.map((p) => ({
              agentID:       p.agentID,
              participantID: p.id,
              agentName:     p.agentName || p.agentID,
            }));

            let result = await discussionOrchestrator.startDiscussion(sessionID, coordinatorList, commit);

            // If bypassed via @mention, schedule only the targeted coordinator
            if (result.bypassed) {
              sessionScheduler.queueTrigger(sessionID, result.targetAgentID);
              return await next(this.context);
            }

            // Discussion started — orchestrator handles scheduling from here
            return await next(this.context);
          }
        }

        // Standard path: 0-1 coordinators or no discussion orchestrator
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
