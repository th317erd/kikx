'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
  buildAgentCompactionPrompt,
  buildDefaultCompactionInstructions,
} from '../../../src/core/compaction/index.mjs';

test('agent compaction template names compaction frames and preserves critical instructions', () => {
  let prompt = buildAgentCompactionPrompt({
    contextText: 'user: edit /tmp/project/app.mjs\nagent: ran npm test',
    sessionID: 'ses_1',
    frameCount: 2,
    startFrameID: 'msg_1',
    boundaryFrameID: 'msg_2',
    contextTokenBudget: 12000,
  });

  assert.equal(COMPACTION_FRAME_TYPE, 'CompactionFrame');
  assert.equal(COMPACTION_FRAME_KIND, 'compaction_frame');
  assert.match(buildDefaultCompactionInstructions(), /Retain important details/);
  assert.match(prompt, /Context memory to compact:/);
  assert.match(prompt, /\/tmp\/project\/app\.mjs/);
  assert.match(prompt, /"boundaryFrameID": "msg_2"/);
  assert.match(prompt, /Return only the compacted context memory/);
});

