'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../../src/core/frames/frame-engine.mjs';
import { ToolExecutionService } from '../../../src/core/tools/tool-execution-service.mjs';
import { processPendingToolCalls } from '../../../src/core/tools/pending-tool-recovery.mjs';

class EchoTool {
  static frameType = 'EchoToolFrame';
  async execute(input) {
    return { echo: input.text };
  }
}

test('pending tool calls are resumed once and wake their agent', async () => {
  let frameEngine = new FrameEngine({ clock: () => 1000 });
  let session = { id: 'ses_1', title: 'Recovery', participantAgentIDs: [ 'agent_1' ] };
  frameEngine.merge([ {
    id: 'call_1',
    type: 'EchoToolFrame',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    authorType: 'agent',
    authorID: 'agent_1',
    createdAt: 500,
    updatedAt: 500,
    startedProcessingAt: null,
    finishedProcessingAt: null,
    content: {
      toolName: 'echo',
      phase: 'call',
      toolCallID: 'tool_1',
      status: 'running',
      input: { text: 'hello' },
    },
  } ]);

  let scheduled = [];
  let frameRuntime = {
    listSessions: async () => [ session ],
    ensureSessionEntry: async () => ({ session, frameEngine }),
    frameStore: { flush: async () => {} },
    clock: () => 1000,
    idGenerator: () => 'wake_1',
    scheduledFrames: { trackFrames: (frames) => scheduled.push(...frames) },
  };
  let toolExecutor = new ToolExecutionService();
  let result = await processPendingToolCalls({
    frameRuntime,
    toolExecutor,
    pluginRegistry: { getTool: () => EchoTool },
    agentManager: { getAgent: async () => ({ id: 'agent_1', name: 'Agent One' }) },
    services: { frameRuntime },
    logger: { warn() {}, error() {} },
  });

  let frames = frameEngine.toArray();
  let call = frames.find((frame) => frame.id === 'call_1');
  let resultFrame = frames.find((frame) => frame.content?.phase === 'result');
  assert.equal(result.processed, 1);
  assert.equal(result.wakes, 1);
  assert.equal(call.startedProcessingAt, 1000);
  assert.equal(call.finishedProcessingAt, 1000);
  assert.equal(resultFrame.content.status, 'success');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].targetAgentID, 'agent_1');
  assert.match(scheduled[0].content.text, /resumed pending tool call/);
});

test('a pending call with truncated input is failed without replay', async () => {
  let frameEngine = new FrameEngine({ clock: () => 1000 });
  let session = { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] };
  frameEngine.merge([ {
    id: 'call_1',
    type: 'EchoToolFrame',
    sessionID: 'ses_1',
    authorID: 'agent_1',
    createdAt: 500,
    startedProcessingAt: null,
    finishedProcessingAt: null,
    content: {
      toolName: 'echo',
      phase: 'call',
      toolCallID: 'tool_1',
      status: 'running',
      input: { truncated: true, preview: '{"text":"hello"}' },
    },
  } ]);

  let frameRuntime = {
    listSessions: async () => [ session ],
    ensureSessionEntry: async () => ({ session, frameEngine }),
    frameStore: { flush: async () => {} },
    clock: () => 1000,
    idGenerator: () => 'wake_1',
    scheduledFrames: { trackFrames: () => {} },
  };
  let toolExecutor = new ToolExecutionService();
  let result = await processPendingToolCalls({
    frameRuntime,
    toolExecutor,
    pluginRegistry: { getTool: () => EchoTool },
    agentManager: { getAgent: async () => ({ id: 'agent_1' }) },
    services: { frameRuntime },
    logger: { warn() {}, error() {} },
  });

  let call = frameEngine.toArray().find((frame) => frame.id === 'call_1');
  let resultFrame = frameEngine.toArray().find((frame) => frame.content?.phase === 'result');
  assert.equal(result.failed, 1);
  assert.equal(call.finishedProcessingAt, 1000);
  assert.equal(resultFrame.content.status, 'error');
  assert.match(resultFrame.content.message, /stored input was truncated/);
});
