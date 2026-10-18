'use strict';

import { installRuntimeMethods } from './frame-runtime-mixins.mjs';
import {
  MAX_SESSION_FRAME_LIMIT,
  normalizeFrameLimit,
  normalizeFrameOffset,
  normalizeFrameWindowLimit,
  normalizeRecoveryLimit,
} from './frame-runtime-normalize.mjs';
import {
  collectToolResultIDs,
  createRecoveredAgentResponseFrame,
  createRecoveredToolCallFrame,
  isStaleAgentResponseFrame,
  isStaleToolCallFrame,
} from './frame-runtime-recovery.mjs';
import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';

const frameMethods = {
  async listFrames(sessionID, options = {}) {
    let hasPagingOptions = options.limit != null || options.offset != null;
    let limit = normalizeFrameLimit(options.limit);
    let offset = normalizeFrameOffset(options.offset);
    let loadLimit = hasPagingOptions ? normalizeFrameWindowLimit(offset + limit) : limit;
    let entry = await this.ensureSessionEntry(sessionID, { frameLimit: loadLimit });
    let frames = projectFrameMessages(entry.frameEngine.toArray());

    if (hasPagingOptions)
      return frames.slice(offset, offset + limit);

    return frames;
  },

  async listFrameWindow(sessionID, options = {}) {
    return await this.frameStore.listFrameWindow(sessionID, options);
  },

  async listSessionPreviews(sessionIDs, options = {}) {
    return await this.frameStore.listSessionPreviews(sessionIDs, options);
  },

  async recoverStaleRuntimeFrames(options = {}) {
    let sessions = await this.listSessions({
      limit: normalizeRecoveryLimit(options.sessionLimit, 500),
      offset: 0,
    });
    let recoveredAgentResponses = 0;
    let recoveredToolCalls = 0;
    let recoveredTurns = 0;

    for (let session of sessions) {
      if (!session?.id)
        continue;

      let entry = await this.ensureSessionEntry(session.id, {
        frameLimit: normalizeFrameLimit(options.frameLimit || MAX_SESSION_FRAME_LIMIT),
      });
      let frames = entry.frameEngine.toArray();
      let toolResultIDs = collectToolResultIDs(frames);
      let updates = [];

      let retryTriggerIDs = new Set();
      for (let frame of frames) {
        if (isStaleAgentResponseFrame(frame)) {
          updates.push(createRecoveredAgentResponseFrame(frame, {
            clock: this.clock,
            message: options.agentMessage,
          }));
          if (frame.parentID)
            retryTriggerIDs.add(frame.parentID);
          recoveredAgentResponses++;
          continue;
        }

        if (isStaleToolCallFrame(frame, toolResultIDs)) {
          updates.push(createRecoveredToolCallFrame(frame, {
            clock: this.clock,
            message: options.toolMessage,
          }));
          recoveredToolCalls++;
        }
      }

      if (updates.length > 0) {
        entry.frameEngine.merge(updates, {
          authorType: 'system',
          authorID: 'runtime-recovery',
          silent: true,
        });
        await this.frameStore.flush();
      }

      // Re-drive interrupted turns. A stale streaming response's `parentID` is the
      // frame that triggered the turn; mark that trigger as a durable scheduled
      // item (scheduledAt = now) so the scheduled-frame queue reloads and dispatches
      // it on boot — the turn resumes instead of dying. This merge is silent, so it
      // does not route immediately; the queue owns the (re)dispatch.
      for (let triggerID of retryTriggerIDs) {
        let trigger = entry.frameEngine.get(triggerID);
        if (!trigger || trigger.deleted === true || trigger.hidden === true)
          continue;

        let merged = entry.frameEngine.merge([ {
          ...trigger,
          scheduledAt: this.clock(),
          scheduledStatus: 'pending',
        } ], {
          authorType: 'system',
          authorID: 'runtime-recovery',
          silent: true,
        });

        this.scheduledFrames?.trackFrame?.(merged?.[0] || entry.frameEngine.get(triggerID));
        recoveredTurns++;
      }

      if (retryTriggerIDs.size > 0)
        await this.frameStore.flush();
    }

    return {
      sessionsScanned: sessions.length,
      recoveredAgentResponses,
      recoveredToolCalls,
      recoveredTurns,
      recovered: recoveredAgentResponses + recoveredToolCalls,
    };
  },
};

export function installFrameMethods(prototype) {
  installRuntimeMethods(prototype, frameMethods);
}
