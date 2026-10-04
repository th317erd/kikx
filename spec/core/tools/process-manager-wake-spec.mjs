'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleWake, setWake } from '../../../src/core/tools/process-manager-wake.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import {
  MAX_AUTONOMOUS_CHAIN_STEPS,
  AUTONOMOUS_PAUSE_NOTICE_TEXT,
} from '../../../src/core/runtime/autonomous-chain.mjs';

function createHarness() {
  let merged = [];
  let mergeCalls = [];
  let processedScheduledFrames = false;
  let id = 0;
  let frameRuntime = {
    clock: () => 1000,
    idGenerator: () => `frame_${++id}`,
    async ensureSessionEntry(sessionID) {
      return {
        session: { id: sessionID },
        frameEngine: {
          merge(frames, options) {
            mergeCalls.push({ frames: frames.slice(), options });
            merged.push(...frames);
            return frames;
          },
        },
      };
    },
    frameStore: {
      async flush() {},
    },
    async processScheduledFrames() {
      processedScheduledFrames = true;
    },
  };
  let manager = {
    frameRuntime,
    logger: { error() {} },
    clock: () => 1000,
  };

  return {
    manager,
    merged,
    mergeCalls,
    scheduledFrames: () => merged.filter((frame) => frame.type === 'UserMessage'),
    notices: () => merged.filter((frame) => frame.type === 'SystemNotice'),
    wasProcessed: () => processedScheduledFrames,
  };
}

function createRecord(overrides = {}) {
  return {
    processID: 'PROC1',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    frameID: 'frm_1',
    status: 'completed',
    completionToolOutputID: 'OUT1',
    wakeFrameID: null,
    wakeCompletionOutputID: null,
    wakeOnCompletion: null,
    ...overrides,
  };
}

test('scheduleWake schedules at most one wake per completion output id', async () => {
  let harness = createHarness();
  let record = createRecord();
  setWake(harness.manager, record, {}, { frame: { id: 'frm_1' } }, 'continue');

  let first = await scheduleWake(harness.manager, record);
  assert.ok(first);
  assert.equal(harness.scheduledFrames().length, 1);
  assert.equal(record.wakeCompletionOutputID, 'OUT1');

  // Simulate the record losing its frame id (e.g. a rehydrated record): the
  // output-id guard must still prevent a second wake for the same completion.
  record.wakeFrameID = null;
  let second = await scheduleWake(harness.manager, record);

  assert.equal(second, null);
  assert.equal(harness.scheduledFrames().length, 1);
});

test('scheduleWake stamps continuationDepth on the wake frame and continuation', async () => {
  let harness = createHarness();
  let record = createRecord();
  setWake(harness.manager, record, {}, { frame: { id: 'frm_1', continuationDepth: 5 } }, 'continue');

  await scheduleWake(harness.manager, record);

  let [ wakeFrame ] = harness.scheduledFrames();
  assert.equal(wakeFrame.continuationDepth, 6);
  assert.equal(wakeFrame.continuation.continuationDepth, 6);
});

test('scheduleWake pauses a chain at the limit with a single notice and no wake frame', async () => {
  let harness = createHarness();
  let record = createRecord();
  setWake(harness.manager, record, {}, { frame: { id: 'frm_1', continuationDepth: MAX_AUTONOMOUS_CHAIN_STEPS } }, 'continue');

  let result = await scheduleWake(harness.manager, record);

  assert.equal(result, null);
  assert.deepEqual(harness.scheduledFrames(), []);
  let notices = harness.notices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].content.text, AUTONOMOUS_PAUSE_NOTICE_TEXT);
  assert.equal(notices[0].hidden, false);
  assert.equal(record.wakePausedAt, 1000);
  assert.equal(harness.wasProcessed(), false);
  // The notice commit is silent, so the frame router never sees it and it
  // cannot re-enter the agent router.
  assert.equal(harness.mergeCalls.at(-1).options.silent, true);
});

test('scheduleWake pause notice never re-enters the frame router in a real runtime', async () => {
  let routed = [];
  let router = new FrameRouter({ logger: { error() {} } });

  class Observer {
    process(next) {
      routed.push(this.context.newFrame.type);
      next(this.context);
    }
  }

  router.registerSelector('Type:UserMessage', Observer, 'user-observer');
  router.registerSelector('Type:SystemNotice', Observer, 'notice-observer');

  let runtime = new FrameRuntime({
    aeordb: { calls: [], files: new Map(), async putFile() {}, async getFile() { return null; }, async listDirectory() { return { items: [] }; } },
    frameRouter: router,
    clock: () => 1000,
    idGenerator: (() => {
      let ids = [ 'ses_1' ];
      let index = 0;
      return () => ids[index++] || `gen_${index}`;
    })(),
  });

  await runtime.createSession({ title: 'Scratch' });
  let manager = {
    frameRuntime: runtime,
    logger: { error() {} },
    clock: () => 1000,
  };
  let record = createRecord({ sessionID: 'ses_1' });
  setWake(manager, record, {}, { frame: { id: 'frm_1', continuationDepth: MAX_AUTONOMOUS_CHAIN_STEPS } }, 'continue');

  await scheduleWake(manager, record);
  await router.flush();

  // Only silent activity: neither the wake frame nor the notice reached the
  // router, so no agent turn is triggered.
  assert.deepEqual(routed, []);
});
