'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { InteractionLoop }  from '../../../src/core/interaction/index.mjs';
import { SessionManager }   from '../../../src/core/session/index.mjs';
import { FramePersistence }  from '../../../src/core/frames/index.mjs';
import { AgentInterface }   from '../../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Render Hint Integration Tests
// =============================================================================
// Verifies that when a tool returns output with a _renderHint property:
//   1. A visible `tool-activity` frame is created with the hint's renderType/renderData
//   2. The `_renderHint` is stripped from the tool-result passed to the agent
//   3. Without _renderHint, no tool-activity frame is created
// =============================================================================

// ---------------------------------------------------------------------------
// MockAgent — yields a single tool-call, then done
// ---------------------------------------------------------------------------

class ToolCallingAgent extends AgentInterface {
  static pluginID    = 'mock-tool-agent';
  static featureName = 'mock';
  static displayName = 'Mock Tool Agent';
  static description = 'Mock agent that calls a tool';
  static agentType   = 'mock';

  constructor(context, toolName, toolArgs) {
    super(context);
    this._toolName = toolName;
    this._toolArgs = toolArgs;
    this._toolResult = null;
  }

  get lastToolResult() {
    return this._toolResult;
  }

  async *_createGenerator(_params) {
    let result = yield {
      type:    'tool-call',
      content: {
        toolName:  this._toolName,
        toolUseId: 'tu_test_render_hint',
        arguments: this._toolArgs,
      },
    };

    // Capture the tool result so the test can inspect what the agent received
    this._toolResult = result;

    yield { type: 'message', content: { html: '<p>done</p>' }, authorType: 'agent' };
    yield { type: 'done', content: {} };
  }
}

describe('InteractionLoop render hints', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;
  let organization;
  let session;

  before(async () => {
    core             = createKikxCore();
    await core.start();
    models           = core.getModels();
    context          = core.getContext();
    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    interactionLoop = new InteractionLoop(context);
    organization    = await models.Organization.create({ name: 'Render Hint Org' });
    session         = await sessionManager.createSession(organization.id);
  });

  // ---------------------------------------------------------------------------
  // Tool with _renderHint → tool-activity frame created
  // ---------------------------------------------------------------------------

  it('creates a tool-activity frame when tool output has _renderHint', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-render-hint-agent',
      pluginID:       'mock-tool-agent',
    });

    let mockAgent = new ToolCallingAgent(context, 'files:read', { filePath: '/test/file.mjs' });

    let executeTool = async (_toolName, _toolArgs) => {
      return {
        content:    'file contents here',
        filePath:   '/test/file.mjs',
        lineCount:  10,
        totalLines: 10,
        truncated:  false,
        _renderHint: {
          renderType: 'file-read',
          renderData: {
            filePath:  '/test/file.mjs',
            content:   'file contents here',
            lineCount: 10,
            totalLines: 10,
            offset:    0,
            truncated: false,
            language:  'javascript',
          },
        },
      };
    };

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'read the file',
      executeTool,
    });

    // Load all frames and check for tool-activity
    let frameManager  = await framePersistence.loadFrames(session.id);
    let allFrames     = frameManager.toArray();
    let activityFrame = allFrames.find((f) => f.type === 'tool-activity');

    assert.ok(activityFrame, 'A tool-activity frame should be created');
    assert.equal(activityFrame.content.renderType, 'file-read');
    assert.equal(activityFrame.content.toolName, 'files:read');
    assert.equal(activityFrame.content.renderData.filePath, '/test/file.mjs');
    assert.equal(activityFrame.content.renderData.language, 'javascript');
    assert.equal(activityFrame.content.renderData.lineCount, 10);
    assert.equal(activityFrame.hidden, false, 'tool-activity frame should be visible');
    assert.equal(activityFrame.authorType, 'system');
  });

  // ---------------------------------------------------------------------------
  // _renderHint stripped from tool-result
  // ---------------------------------------------------------------------------

  it('strips _renderHint from tool-result frame content', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-strip-hint-agent',
      pluginID:       'mock-tool-agent',
    });

    let mockAgent = new ToolCallingAgent(context, 'files:write', { filePath: '/test/out.txt', content: 'hello' });

    let executeTool = async () => {
      return {
        message:  'Created: /test/out.txt',
        filePath: '/test/out.txt',
        created:  true,
        _renderHint: {
          renderType: 'file-write',
          renderData: { filePath: '/test/out.txt', created: true, diff: { hunks: [], additions: 3, removals: 0 } },
        },
      };
    };

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'write the file',
      executeTool,
    });

    // Check tool-result frame — _renderHint should NOT be in the output
    let frameManager  = await framePersistence.loadFrames(session.id);
    let allFrames     = frameManager.toArray();
    let toolResult    = allFrames.find((f) => f.type === 'tool-result');

    assert.ok(toolResult, 'A tool-result frame should exist');

    let output = toolResult.content.output;

    // output may be an object or string — handle both
    if (typeof output === 'string') {
      assert.ok(!output.includes('_renderHint'), 'tool-result should not contain _renderHint as string');
    } else if (output && typeof output === 'object') {
      assert.equal(output._renderHint, undefined, 'tool-result output should not have _renderHint property');
      assert.equal(output.message, 'Created: /test/out.txt', 'tool-result should still have the clean output');
      assert.equal(output.filePath, '/test/out.txt');
      assert.equal(output.created, true);
    }
  });

  // ---------------------------------------------------------------------------
  // Tool without _renderHint → no tool-activity frame
  // ---------------------------------------------------------------------------

  it('does not create tool-activity frame when tool output has no _renderHint', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-no-hint-agent',
      pluginID:       'mock-tool-agent',
    });

    let mockAgent = new ToolCallingAgent(context, 'shell:execute', { command: 'echo hello' });

    let executeTool = async () => {
      return {
        stdout:   'hello\n',
        stderr:   '',
        exitCode: 0,
        // No _renderHint
      };
    };

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'run the command',
      executeTool,
    });

    let frameManager    = await framePersistence.loadFrames(session.id);
    let allFrames       = frameManager.toArray();
    let activityFrames  = allFrames.filter((f) => f.type === 'tool-activity');

    assert.equal(activityFrames.length, 0, 'No tool-activity frame should be created without _renderHint');
  });

  // ---------------------------------------------------------------------------
  // String tool output → no tool-activity frame
  // ---------------------------------------------------------------------------

  it('does not create tool-activity frame for string tool output', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-string-output-agent',
      pluginID:       'mock-tool-agent',
    });

    let mockAgent = new ToolCallingAgent(context, 'some:tool', {});

    let executeTool = async () => 'plain string output';

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'do something',
      executeTool,
    });

    let frameManager   = await framePersistence.loadFrames(session.id);
    let allFrames      = frameManager.toArray();
    let activityFrames = allFrames.filter((f) => f.type === 'tool-activity');

    assert.equal(activityFrames.length, 0, 'No tool-activity frame for string output');
  });

  // ---------------------------------------------------------------------------
  // tool-activity frame has correct interactionID
  // ---------------------------------------------------------------------------

  it('tool-activity frame shares the same interactionID as other frames', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-interaction-id-agent',
      pluginID:       'mock-tool-agent',
    });

    let mockAgent = new ToolCallingAgent(context, 'files:edit', { filePath: '/test/edit.txt', oldString: 'a', newString: 'b' });

    let executeTool = async () => ({
      message:  'Edited: /test/edit.txt',
      filePath: '/test/edit.txt',
      _renderHint: {
        renderType: 'file-write',
        renderData: { filePath: '/test/edit.txt', created: false, diff: { hunks: [], additions: 1, removals: 1 } },
      },
    });

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'edit the file',
      executeTool,
    });

    let frameManager  = await framePersistence.loadFrames(session.id);
    let allFrames     = frameManager.toArray();
    let activityFrame = allFrames.find((f) => f.type === 'tool-activity');
    let toolCallFrame = allFrames.find((f) => f.type === 'tool-call');
    let toolResult    = allFrames.find((f) => f.type === 'tool-result');

    assert.ok(activityFrame);
    assert.ok(toolCallFrame);
    assert.ok(toolResult);

    // All three should share the same interactionID
    assert.equal(activityFrame.interactionID, toolCallFrame.interactionID, 'tool-activity should share interactionID with tool-call');
    assert.equal(activityFrame.interactionID, toolResult.interactionID, 'tool-activity should share interactionID with tool-result');
  });

  // ---------------------------------------------------------------------------
  // Both tool-activity and tool-result frames exist (not one-or-the-other)
  // ---------------------------------------------------------------------------

  it('creates both tool-activity and tool-result frames', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-both-frames-agent',
      pluginID:       'mock-tool-agent',
    });

    let mockAgent = new ToolCallingAgent(context, 'files:read', {});

    let executeTool = async () => ({
      content: 'data',
      _renderHint: { renderType: 'file-read', renderData: { filePath: '/x' } },
    });

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'read',
      executeTool,
    });

    let frameManager   = await framePersistence.loadFrames(session.id);
    let allFrames      = frameManager.toArray();
    let activityFrames = allFrames.filter((f) => f.type === 'tool-activity');
    let resultFrames   = allFrames.filter((f) => f.type === 'tool-result');

    assert.equal(activityFrames.length, 1, 'Exactly 1 tool-activity frame');
    assert.equal(resultFrames.length, 1, 'Exactly 1 tool-result frame');
  });
});
