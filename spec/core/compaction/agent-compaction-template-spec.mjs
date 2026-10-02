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

test('default compaction instructions request priority-tagged sections', () => {
  let instructions = buildDefaultCompactionInstructions();
  assert.match(instructions, /PRIORITIZED summary/);
  assert.match(instructions, /\[high\]: must-keep/);
  assert.match(instructions, /\[medium\]: useful context/);
  assert.match(instructions, /\[low\]: chatter/);
  assert.match(instructions, /three priority sections/);
  assert.match(instructions, /safe to drop first/i);
  assert.match(instructions, /never dropped/);
  assert.match(instructions, /Do not invent facts/);
  assert.match(instructions, /minimize overall memory loss/);
});

test('default compaction instructions prune dynamically injected fields from the retain list', () => {
  let instructions = buildDefaultCompactionInstructions();
  let retainLine = instructions.split('\n').find((line) => /^Retain important details/.test(line));

  assert.ok(retainLine, 'retain instruction is present');
  assert.match(retainLine, /file paths/);
  assert.match(retainLine, /tool run IDs/);
  assert.doesNotMatch(retainLine, /\bactor names\b/i);
  assert.doesNotMatch(retainLine, /\bagent names\b/i);
  assert.doesNotMatch(retainLine, /\btodos?\b/i);
  assert.doesNotMatch(retainLine, /\bcwd\b/i);
  assert.doesNotMatch(retainLine, /working directory/i);
  assert.doesNotMatch(retainLine, /\bcharacter\b/i);
  assert.doesNotMatch(retainLine, /tool list/i);
});

test('default compaction instructions discard large low-value blobs', () => {
  let instructions = buildDefaultCompactionInstructions();
  assert.match(instructions, /base64/i);
  assert.match(instructions, /large low-value blobs/i);
  assert.match(instructions, /referenced elsewhere/i);
  assert.match(instructions, /tool-output ID or locator/i);
});

test('default compaction instructions append a realign/reorient hook', () => {
  let instructions = buildDefaultCompactionInstructions();
  assert.match(instructions, /realign and reorient/);
  assert.match(instructions, /vision and mission/);
});

