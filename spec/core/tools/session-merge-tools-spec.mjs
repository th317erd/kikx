'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionMergeStatusTool,
  SessionMergeTool,
} from '../../../src/core/tools/session-merge-tools.mjs';

function createContext({ isCoordinator = true } = {}) {
  let starts = [];
  let service = {
    async startMerge(input) {
      starts.push(input);
      return { mergeID: 'merge_1', status: 'running', targetSessionID: input.targetSessionID };
    },
    async getMerge(id) {
      return id === 'merge_1' ? { mergeID: id, status: 'complete' } : null;
    },
    async listMerges() {
      return [ { mergeID: 'merge_1', status: 'complete' } ];
    },
  };
  return {
    starts,
    context: {
      isCoordinator,
      session: { id: 'target' },
      agent: { id: 'agent_1' },
      frame: { id: 'frame_1' },
      sessionMergeService: service,
    },
  };
}

test('session-merge is coordinator-only and starts an async merge', async () => {
  let blocked = createContext({ isCoordinator: false });
  await assert.rejects(
    () => new SessionMergeTool(blocked.context).execute({ session_ids: [ 'a', 'b' ] }),
    /only available to the session coordinator/,
  );

  let { context, starts } = createContext();
  let result = await new SessionMergeTool(context).execute({
    target_session_id: 'target',
    session_ids: [ 'target', 'source-a' ],
    close_sessions: true,
  });

  assert.equal(result.mergeID, 'merge_1');
  assert.deepEqual(starts, [ {
    targetSessionID: 'target',
    sessionIDs: [ 'target', 'source-a' ],
    closeSessions: true,
    requestedByAgentID: 'agent_1',
    requestedByFrameID: 'frame_1',
    services: null,
    routerContext: context,
  } ]);
});

test('session-merge-status is coordinator-only and can read or list jobs', async () => {
  let blocked = createContext({ isCoordinator: false });
  await assert.rejects(
    () => new SessionMergeStatusTool(blocked.context).execute({ merge_id: 'merge_1' }),
    /only available to the session coordinator/,
  );

  let { context } = createContext();
  let one = await new SessionMergeStatusTool(context).execute({ merge_id: 'merge_1' });
  assert.deepEqual(one, { mergeID: 'merge_1', status: 'complete' });

  let listed = await new SessionMergeStatusTool(context).execute({});
  assert.deepEqual(listed.merges.map((job) => job.mergeID), [ 'merge_1' ]);
});
