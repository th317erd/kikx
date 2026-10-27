'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCompactionFrame } from '../../../src/core/compaction/compaction-frame.mjs';

test('a merge compaction frame carries its source-session metadata', () => {
  let merge = {
    kind: 'session_merge',
    targetSessionID: 'target',
    sessionIDs: [ 'target', 'source-a' ],
    compactedSessionIDs: [ 'target' ],
    untouchedSessionIDs: [ 'source-a' ],
    closedSessionIDs: [],
  };
  let frame = buildCompactionFrame({
    id: 'merge-1',
    now: 1000,
    session: { id: 'target' },
    compactorAgent: { id: 'compactor', name: 'Compactor' },
    compactionWindow: {
      frames: [
        { id: 'source-frame', order: 2, timestamp: 900 },
        { id: 'target-frame', order: 1, timestamp: 800 },
      ],
      startFrameID: 'source-frame',
      boundaryFrameID: 'target-frame',
      boundaryOrder: 1,
      tokens: 500,
    },
    summary: '[high]\nMerged memory.',
    status: 'complete',
    manual: true,
    merge,
  });

  assert.equal(frame.type, 'CompactionFrame');
  assert.equal(frame.sessionID, 'target');
  assert.deepEqual(frame.compaction.frameIDs, [ 'source-frame', 'target-frame' ]);
  assert.equal(frame.compaction.boundaryFrameID, 'target-frame');
  assert.deepEqual(frame.compaction.merge, merge);
  assert.deepEqual(frame.content.merge, merge);
  assert.equal(frame.content.summary, '[high]\nMerged memory.');
});
