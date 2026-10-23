'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../../src/core/frames/frame-engine.mjs';
import { ToolExecutionService } from '../../../src/core/tools/tool-execution-service.mjs';
import { ToolShutdownState } from '../../../src/core/tools/tool-shutdown-state.mjs';

class SlowTool {
  static frameType = 'SlowToolFrame';

  async execute() {
    await this.context.services.gate;
    return { ok: true };
  }
}

function createLifecycleHarness() {
  let frameEngine = new FrameEngine({ clock: () => 1000 });
  let shutdownState = new ToolShutdownState();
  let executor = new ToolExecutionService({ shutdownState });
  let context = {
    session: { id: 'ses_1' },
    frame: { id: 'trigger_1', interactionID: 'int_1' },
    frameEngine,
    services: {
      frameEngine,
      frameRuntime: { frameStore: { async flush() {} } },
      shutdownState,
      clock: () => 1000,
    },
  };
  return { frameEngine, shutdownState, executor, context };
}

async function waitFor(predicate, timeoutMS = 300) {
  let deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (predicate())
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition');
}

test('a tool call is marked started before execution and finished after its result', async () => {
  let { frameEngine, shutdownState, executor, context } = createLifecycleHarness();
  let resolveGate;
  context.services.gate = new Promise((resolve) => { resolveGate = resolve; });
  let SlowToolClass = class extends SlowTool {
    constructor(executionContext) {
      super();
      this.context = executionContext;
    }
  };

  let pending = executor.executeTool({
    toolName: 'slow-tool',
    ToolClass: SlowToolClass,
    input: {},
    context,
  });

  await waitFor(() => frameEngine.toArray().some((frame) => frame.content?.phase === 'call' && frame.startedProcessingAt != null));
  let call = frameEngine.toArray().find((frame) => frame.content?.phase === 'call');
  assert.equal(call.finishedProcessingAt, null);
  assert.equal(shutdownState.inFlight().length, 1);

  resolveGate();
  await pending;
  call = frameEngine.toArray().find((frame) => frame.content?.phase === 'call');
  assert.equal(call.startedProcessingAt, 1000);
  assert.equal(call.finishedProcessingAt, 1000);
  assert.equal(shutdownState.inFlight().length, 0);
  assert.ok(frameEngine.toArray().some((frame) => frame.content?.phase === 'result'));
});

test('shutdown prevents a not-yet-started tool call from executing', async () => {
  let { frameEngine, shutdownState, executor, context } = createLifecycleHarness();
  let executed = false;
  let SlowToolClass = class extends SlowTool {
    constructor(executionContext) {
      super();
      this.context = executionContext;
    }

    async execute() {
      executed = true;
      return {};
    }
  };

  shutdownState.begin();
  await assert.rejects(
    () => executor.executeTool({ toolName: 'slow-tool', ToolClass: SlowToolClass, input: {}, context }),
    (error) => error.code === 'TOOL_DEFERRED_FOR_SHUTDOWN',
  );

  assert.equal(executed, false);
  let call = frameEngine.toArray().find((frame) => frame.content?.phase === 'call');
  assert.ok(call, 'the pending request remains durable');
  assert.equal(call.startedProcessingAt, null);
  assert.equal(call.finishedProcessingAt, null);
  assert.equal(frameEngine.toArray().some((frame) => frame.content?.phase === 'result'), false);
});

test('deadline abandonment writes an explicit failed result and closes the call', async () => {
  let { frameEngine, shutdownState, executor, context } = createLifecycleHarness();
  context.services.gate = new Promise(() => {});
  let SlowToolClass = class extends SlowTool {
    constructor(executionContext) {
      super();
      this.context = executionContext;
    }
  };

  executor.executeTool({ toolName: 'slow-tool', ToolClass: SlowToolClass, input: {}, context }).catch(() => {});
  await waitFor(() => shutdownState.inFlight().length === 1);

  let remaining = shutdownState.abandonRemaining();
  await executor.failInterruptedToolCalls(remaining, {
    message: 'Execution interrupted. Command was NOT completed successfully.',
  });

  let call = frameEngine.toArray().find((frame) => frame.content?.phase === 'call');
  let result = frameEngine.toArray().find((frame) => frame.content?.phase === 'result');
  assert.equal(call.finishedProcessingAt, 1000);
  assert.equal(result.content.status, 'error');
  assert.match(result.content.message, /NOT completed successfully/);
});
