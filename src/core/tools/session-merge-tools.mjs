'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

class SessionMergeToolBase extends PluginInterface {
  static pluginID = 'internal:session-merge';
  static clientComponent = builtInToolComponent('kikx-session-tool-use');
  static riskLevel = 'none';

  assertCoordinator() {
    if (this.context?.isCoordinator !== true)
      throw new Error('Session merge tools are only available to the session coordinator');
  }

  mergeService() {
    let service = this.context.sessionMergeService
      || this.context.services?.sessionMergeService
      || resolveService(this.context, 'sessionMergeService');
    if (!service)
      throw new Error('Session merge tools require a sessionMergeService');
    return service;
  }
}

export class SessionMergeTool extends SessionMergeToolBase {
  static featureName = 'session-merge';
  static displayName = 'Merge sessions';
  static description = 'Coordinator-only: compact and merge multiple session histories into a single history in the target session.';
  static frameType = 'SessionMergeToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      session_ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        description: 'Two or more session IDs to merge. The target is included automatically if omitted.',
      },
      target_session_id: {
        type: 'string',
        description: 'Session that receives the merged compaction frame. Defaults to the current session. The target is the least-priority input because its material is already in the destination.',
      },
      close_sessions: {
        type: 'boolean',
        description: 'When true, soft-delete the source sessions after the merge frame is stored. The target is never closed.',
      },
    },
    required: [ 'session_ids' ],
    additionalProperties: false,
  };
  static help = [
    'Coordinator-only. Use session-merge to consolidate two or more session histories into one compaction frame in target_session_id.',
    'The tool starts an asynchronous merge and returns a merge ID immediately; you will be woken when it completes. Do not poll while waiting.',
    'If the combined context fits the compactor window, it is compacted as one input. Otherwise the target is compacted first, then the largest source sessions, in parallel batches, until the merge input fits.',
    'Set close_sessions:true to soft-delete the source sessions after the merge frame is stored. The target remains open.',
    'Use session-merge-status to inspect a merge job or list recent merge jobs.',
  ].join(' ');

  async _execute(params = {}) {
    this.assertCoordinator();
    let sessionIDs = Array.isArray(params.session_ids || params.sessionIDs)
      ? (params.session_ids || params.sessionIDs)
      : [];
    let job = await this.mergeService().startMerge({
      targetSessionID: params.target_session_id || params.targetSessionID || this.context.session?.id || null,
      sessionIDs,
      closeSessions: params.close_sessions === true || params.closeSessions === true,
      requestedByAgentID: this.context.agent?.id || null,
      requestedByFrameID: this.context.frame?.id || null,
      services: this.context.services || null,
      routerContext: this.context,
    });
    return {
      ...job,
      message: `Session merge ${job.mergeID} is running. You will be woken when it completes; do not poll.`,
    };
  }
}

export class SessionMergeStatusTool extends SessionMergeToolBase {
  static featureName = 'session-merge-status';
  static displayName = 'Session merge status';
  static description = 'Coordinator-only: inspect one session merge job or list recent merge jobs.';
  static frameType = 'SessionMergeStatusToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      merge_id: {
        type: 'string',
        description: 'Merge ID returned by session-merge. Omit to list recent merges.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum recent merges to list when merge_id is omitted.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Coordinator-only. Use session-merge-status with merge_id to inspect one merge, or omit it to list recent merge jobs. A completed merge normally also wakes you automatically.';

  async _execute(params = {}) {
    this.assertCoordinator();
    let mergeID = typeof params.merge_id === 'string' ? params.merge_id.trim() : '';
    if (mergeID) {
      let job = await this.mergeService().getMerge(mergeID);
      if (!job)
        throw new Error(`Unknown merge: ${mergeID}`);
      return job;
    }

    return {
      merges: await this.mergeService().listMerges({ limit: params.limit }),
    };
  }
}


function resolveService(context = {}, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);
  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {}
  }
  return null;
}
