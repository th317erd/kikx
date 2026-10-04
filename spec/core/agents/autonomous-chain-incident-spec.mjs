'use strict';

// P7 incident regression: production session a07faa16 formed a self-sustaining
// autonomous turn chain (1,248 frames) that only stopped after an ad-hoc
// loop-break. These tests replay the incident's shape end to end against a real
// FrameRuntime and assert it now terminates on its own.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import {
  MAX_AUTONOMOUS_CHAIN_STEPS,
  AUTONOMOUS_PAUSE_NOTICE_TEXT,
} from '../../../src/core/runtime/autonomous-chain.mjs';
import { scheduleWake } from '../../../src/core/tools/process-manager-wake.mjs';

function quietLogger() {
  return { warn() {}, error() {}, log() {}, info() {}, debug() {} };
}

// Minimal in-memory aeordb client compatible with FrameRuntime (mirrors the
// pattern used by spec/core/frame-runtime-spec.mjs).
function createClient() {
  return {
    calls: [],
    files: new Map(),
    async putFile(path, body) {
      this.calls.push({ method: 'putFile', path, body });
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      this.calls.push({ method: 'getFile', path });
      return this.files.get(path) || null;
    },
    async listDirectory(path, requestOptions) {
      this.calls.push({ method: 'listDirectory', path, options: requestOptions });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];
      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;

        if ((requestOptions?.glob === '*/session.json' || requestOptions?.glob === '**/session.json') && !/^\/kikx\/sessions\/[^/]+\/session\.json$/.test(filePath))
          continue;

        if (requestOptions?.glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;

        items.push({ path: filePath });
      }
      return { items };
    },
  };
}

function createIDGenerator(ids) {
  let queue = [ ...ids ];
  let counter = 0;
  return () => queue.shift() || `gen_${++counter}`;
}

function createRuntime(ids) {
  let router = new FrameRouter({ logger: quietLogger() });
  return new FrameRuntime({
    aeordb: createClient(),
    frameRouter: router,
    clock: () => 1000,
    idGenerator: createIDGenerator(ids),
    logger: quietLogger(),
  });
}

function makeWakeRecord({ processID, outputID, agentID = 'agent_1', sessionID = 'ses_1' }) {
  return {
    processID,
    agentID,
    sessionID,
    frameID: 'user_msg_1',
    status: 'completed',
    completionToolOutputID: outputID,
    wakeOnCompletion: {
      agentID,
      sessionID,
      frameID: 'user_msg_1',
      continuationPrompt: 'continue',
      triggerDepth: 0,
    },
    wakeFrameID: null,
    wakeCompletionOutputID: null,
  };
}

test('a repeated async-completion wake chain cannot run away (incident a07faa16)', async () => {
  // Simulate the incident: many distinct completed processes each schedule a
  // wake, each wake turn schedules the next, all without new user input. The
  // chain must trip the fail-safe and stop.
  let runtime = createRuntime([ 'ses_1', 'int_1', 'msg_1' ]);
  await runtime.createSession({ title: 'Kikx' });
  await runtime.appendUserMessage('ses_1', { text: 'go' });

  let manager = {
    frameRuntime: runtime,
    clock: () => 1000,
    logger: quietLogger(),
    processes: new Map(),
    async scheduleWake(record) {
      return await scheduleWake(this, record);
    },
  };

  let scheduled = 0;
  let triggerDepth = 0;
  // Model the real dynamic: only a scheduled wake can become the trigger for the
  // next turn. Once the fail-safe refuses, no new frame exists, so the chain ends.
  for (let step = 0; step < MAX_AUTONOMOUS_CHAIN_STEPS + 5; step++) {
    let record = makeWakeRecord({ processID: `PROC${step}`, outputID: `OUT${step}` });
    record.wakeOnCompletion.triggerDepth = triggerDepth;
    let wakeFrameID = await scheduleWake(manager, record);
    if (!wakeFrameID)
      break;

    scheduled++;
    let entry = runtime.requireSessionEntry('ses_1');
    triggerDepth = Number(entry.frameEngine.get(wakeFrameID)?.continuationDepth) || triggerDepth + 1;
  }

  assert.ok(scheduled <= MAX_AUTONOMOUS_CHAIN_STEPS + 1, `scheduled ${scheduled} <= ${MAX_AUTONOMOUS_CHAIN_STEPS + 1}`);

  let frames = await runtime.listFrames('ses_1');
  let notices = frames.filter((frame) => frame.type === 'SystemNotice');
  assert.equal(notices.length, 1, 'exactly one pause notice');
  assert.equal(notices[0].content.text, AUTONOMOUS_PAUSE_NOTICE_TEXT);

  // The chain did not produce an unbounded number of autonomous frames.
  let autonomous = frames.filter((frame) => Number(frame.continuationDepth) > 0);
  assert.ok(autonomous.length <= MAX_AUTONOMOUS_CHAIN_STEPS, `autonomous frames ${autonomous.length}`);
  assert.ok(frames.length < 100, `total frames stayed bounded (${frames.length})`);
});

test('a user turn cancels the pending autonomous backlog', async () => {
  let runtime = createRuntime([ 'ses_1', 'int_1', 'msg_1', 'msg_2' ]);
  await runtime.createSession({ title: 'Kikx' });
  await runtime.appendUserMessage('ses_1', { text: 'go' });

  let entry = runtime.requireSessionEntry('ses_1');
  // Two pending autonomous wakes, as the incident accumulated.
  for (let i = 0; i < 2; i++) {
    entry.frameEngine.merge([{
      id: `wake_${i}`,
      type: 'UserMessage',
      sessionID: 'ses_1',
      interactionID: 'int_1',
      authorType: 'system',
      authorID: 'internal:process',
      targetAgentID: 'agent_1',
      scheduledAt: 2000,
      scheduledStatus: 'pending',
      hidden: true,
      deleted: false,
      continuation: { kind: 'exec-wake-on-completion', processID: `PROC${i}` },
      content: { text: 'scheduled', status: 'scheduled' },
    }], { authorType: 'system', authorID: 'internal:process' });
  }

  assert.equal(runtime.scheduledFrames.entries.size, 2);

  // The user types again: the backlog is superseded.
  await runtime.appendUserMessage('ses_1', { text: 'hello again' });

  assert.equal(entry.frameEngine.get('wake_0').scheduledStatus, 'cancelled');
  assert.equal(entry.frameEngine.get('wake_1').scheduledStatus, 'cancelled');
  assert.equal(runtime.scheduledFrames.entries.size, 0);
});
