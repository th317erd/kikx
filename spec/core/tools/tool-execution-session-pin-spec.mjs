'use strict';

// P2-a: a cross-session tool call captures the target session's FrameEngine,
// then `await tool.execute(...)` can run for minutes. Without pinning the target
// runtime, ordinary LRU pressure during that await can evict it: eviction
// detaches the store listeners, so recordToolResultFrame() merges into a
// detached engine and the successful result is silently dropped. The spec
// resolves the call only after forcing enough other sessions through the cap to
// make the target the LRU victim.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolExecutionService } from '../../../src/core/tools/tool-execution-service.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';

function createFrameStore() {
  let sessions = new Map();
  let framesBySession = new Map();

  let bucketFor = (sessionID) => {
    if (!framesBySession.has(sessionID))
      framesBySession.set(sessionID, new Map());

    return framesBySession.get(sessionID);
  };

  return {
    frames(sessionID) {
      return Array.from(bucketFor(sessionID).values());
    },
    async saveSession(session) {
      sessions.set(session.id, clone(session));
    },
    async saveSessionManifest(session) {
      sessions.set(session.id, clone(session));
    },
    async loadSession(sessionID) {
      let session = sessions.get(sessionID);
      return session ? clone(session) : null;
    },
    async listSessions() {
      return Array.from(sessions.values()).map(clone);
    },
    async listFrames(sessionID) {
      return Array.from(bucketFor(sessionID).values()).map(clone);
    },
    async flush() {},
    async ensureIndexConfigs() {},
    connect(frameEngine, options = {}) {
      let sessionID = options.sessionID;
      let handler = ({ frames }) => {
        let bucket = bucketFor(sessionID);
        for (let frame of frames || [])
          bucket.set(frame.id, clone(frame));
      };
      frameEngine.on('commit', handler);

      return () => frameEngine.off('commit', handler);
    },
  };
}

function createRuntime(store, options = {}) {
  let index = 0;
  return new FrameRuntime({
    frameStore: store,
    sessionRuntimeLimit: options.sessionRuntimeLimit ?? 2,
    clock: () => 1000 + index,
    idGenerator: () => `id_${++index}`,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('a cross-session tool result is persisted even when the target runtime is LRU pressure during execute()', async () => {
  let store = createFrameStore();
  let runtime = createRuntime(store, { sessionRuntimeLimit: 2 });
  let source = { id: 'source_session' };
  let target = await runtime.createSession({ title: 'Target' });

  let releaseExecute;
  let executeStarted;
  let started = new Promise((resolve) => { executeStarted = resolve; });
  let gate = new Promise((resolve) => { releaseExecute = resolve; });

  class SlowTool {
    static frameType = 'SlowToolFrame';

    constructor(context) {
      this.context = context;
    }

    async execute() {
      executeStarted();
      await gate;
      return { message: 'tool finished' };
    }
  }

  let service = new ToolExecutionService();
  let pending = service.executeTool({
    toolName: 'slow_tool',
    ToolClass: SlowTool,
    input: { session_id: target.id },
    context: { session: source, services: { frameRuntime: runtime } },
  });

  // Wait until execute() is actually in flight (the call frame is already
  // recorded), then push the target past the cap with newer sessions.
  await started;
  await runtime.createSession({ title: 'Other 1' });
  await runtime.createSession({ title: 'Other 2' });

  releaseExecute();
  let result = await pending;
  assert.equal(result.message, 'tool finished');

  let stored = store.frames(target.id);
  let resultFrame = stored.find((frame) => frame.type === 'SlowToolFrame' && frame.content?.phase === 'result');
  assert.ok(
    resultFrame,
    'the tool result frame must be persisted even though the target runtime was under eviction pressure',
  );
  assert.equal(resultFrame.content.status, 'success');
  assert.equal(resultFrame.content.message, 'tool finished');
});

test('a failing cross-session tool releases its target pin so the runtime can be evicted again', async () => {
  let store = createFrameStore();
  let runtime = createRuntime(store, { sessionRuntimeLimit: 1 });
  let source = { id: 'source_session' };
  let target = await runtime.createSession({ title: 'Target' });

  class FailingTool {
    constructor(context) {
      this.context = context;
    }

    async execute() {
      throw new Error('tool exploded');
    }
  }

  let service = new ToolExecutionService();
  await assert.rejects(
    service.executeTool({
      toolName: 'failing_tool',
      ToolClass: FailingTool,
      input: { session_id: target.id },
      context: { session: source, services: { frameRuntime: runtime } },
    }),
    /tool exploded/,
  );

  assert.equal(runtime.sessions.get(target.id)?.activeRuns ?? 0, 0, 'the failure path must not leave the target pinned');

  // With the pin released, a new session can evict the target runtime normally.
  await runtime.createSession({ title: 'Replacement' });
  assert.equal(runtime.sessions.has(target.id), false);
});
