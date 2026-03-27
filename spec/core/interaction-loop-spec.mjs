'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../src/core/index.mjs';
import { InteractionLoop }    from '../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }          from '../../src/core/plugins/agent-interface.mjs';
import { PermissionRequiredError } from '../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// Mock Agent
// =============================================================================
// Configurable mock that extends AgentInterface. Accepts an array of blocks
// to yield, supporting the full yield protocol (message, tool-call,
// reflection, done).
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for testing';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks = blocks || [];
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks) {
      if (block.type === 'ToolCall') {
        let result = yield block;
        // Store result so tests can verify it was passed back
        block._receivedResult = result;
      } else {
        yield block;
      }
    }

    yield { type: 'Done', content: {} };
  }
}

// =============================================================================
// InteractionLoop Tests
// =============================================================================
// One shared KikxCore instance for the entire suite.
// Each test creates its own org + session for isolation.
// =============================================================================

describe('InteractionLoop', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let sanitizer;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager  = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    sanitizer        = new ContentSanitizer();

    // Put dependencies on context so InteractionLoop can find them
    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', sanitizer);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helpers
  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Test Session' });

    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  function defaultParams(agentPlugin, overrides = {}) {
    return {
      agentPlugin,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hello, agent!',
      authorType:  'user',
      authorID:    'user_123',
      ...overrides,
    };
  }

  // ===========================================================================
  // 1. Constructor requires context
  // ===========================================================================

  describe('construction', () => {
    it('should create an instance with a valid context', () => {
      let loop = createLoop();
      assert.ok(loop);
      assert.ok(loop instanceof InteractionLoop);
    });

    it('should throw without a context', () => {
      assert.throws(() => new InteractionLoop(), {
        message: /requires a CascadingContext/,
      });
    });

    it('should throw with null context', () => {
      assert.throws(() => new InteractionLoop(null), {
        message: /requires a CascadingContext/,
      });
    });
  });

  // ===========================================================================
  // 2. startInteraction creates user message frame
  // ===========================================================================

  describe('startInteraction — user message frame', () => {
    it('should create a user-message frame', async () => {
      let session = await createTestSession();
      let agent   = new MockAgent(context, []);
      let loop    = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent));

      // Check that a user-message frame was persisted
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let userFrames = frames.filter((f) => f.type === 'UserMessage');

      assert.equal(userFrames.length, 1);
      assert.equal(userFrames[0].content.text, 'Hello, agent!');
    });

    it('should skip user-message frame when replayFromPermission is true', async () => {
      let session = await createTestSession();
      let agent   = new MockAgent(context, []);
      let loop    = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        replayFromPermission: true,
      }));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let userFrames = frames.filter((f) => f.type === 'UserMessage');

      assert.equal(userFrames.length, 0);
    });
  });

  // ===========================================================================
  // 3. Simple message interaction (agent yields message + done)
  // ===========================================================================

  describe('simple message interaction', () => {
    it('should process a single message block', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Message', content: { html: '<p>Hello!</p>' }, authorType: 'agent', authorID: 'agent_1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      // user-message + message + (done not persisted)
      let messageFrames = frames.filter((f) => f.type === 'Message');
      assert.equal(messageFrames.length, 1);
      assert.equal(messageFrames[0].content.html, '<p>Hello!</p>');
    });
  });

  // ===========================================================================
  // 4. Multiple message blocks in one interaction
  // ===========================================================================

  describe('multiple message blocks', () => {
    it('should process multiple message blocks', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Message', content: { html: '<p>First</p>' }, authorType: 'agent', authorID: 'a1' },
        { type: 'Message', content: { html: '<p>Second</p>' }, authorType: 'agent', authorID: 'a1' },
        { type: 'Message', content: { html: '<p>Third</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let messageFrames = frames.filter((f) => f.type === 'Message');

      assert.equal(messageFrames.length, 3);
      assert.equal(messageFrames[0].content.html, '<p>First</p>');
      assert.equal(messageFrames[1].content.html, '<p>Second</p>');
      assert.equal(messageFrames[2].content.html, '<p>Third</p>');
    });
  });

  // ===========================================================================
  // 5. Reflection blocks are hidden
  // ===========================================================================

  describe('reflection blocks', () => {
    it('should create hidden reflection frames', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Reflection', content: { text: 'Thinking...' }, hidden: true, authorType: 'agent', authorID: 'a1' },
        { type: 'Message', content: { html: '<p>Answer</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let reflections = frames.filter((f) => f.type === 'Reflection');

      assert.equal(reflections.length, 1);
      assert.equal(reflections[0].content.text, 'Thinking...');
      assert.equal(reflections[0].hidden, true);
    });
  });

  // ===========================================================================
  // 6. Message content is sanitized
  // ===========================================================================

  describe('content sanitization', () => {
    it('should sanitize HTML in message content', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Message', content: { html: '<p>Hello</p><script>alert("xss")</script>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let messageFrames = frames.filter((f) => f.type === 'Message');

      assert.equal(messageFrames.length, 1);
      // Script tag should be stripped
      assert.ok(!messageFrames[0].content.html.includes('script'));
      assert.ok(messageFrames[0].content.html.includes('<p>Hello</p>'));
    });
  });

  // ===========================================================================
  // 7. Frames get monotonic order values
  // ===========================================================================

  describe('monotonic order', () => {
    it('should assign monotonically increasing order values', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Message', content: { html: '<p>A</p>' }, authorType: 'agent', authorID: 'a1' },
        { type: 'Message', content: { html: '<p>B</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      // Frames should be in ascending order
      for (let i = 1; i < frames.length; i++)
        assert.ok(frames[i].order > frames[i - 1].order, `frame[${i}].order (${frames[i].order}) should be > frame[${i - 1}].order (${frames[i - 1].order})`);
    });
  });

  // ===========================================================================
  // 8. Frames get timestamps
  // ===========================================================================

  describe('timestamps', () => {
    it('should assign timestamps to all frames', async () => {
      let session = await createTestSession();
      let before  = Date.now();
      let blocks  = [
        { type: 'Message', content: { html: '<p>A</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      for (let frame of frames) {
        assert.ok(typeof frame.timestamp === 'number');
        assert.ok(frame.timestamp >= before, `frame.timestamp (${frame.timestamp}) should be >= before (${before})`);
      }
    });
  });

  // ===========================================================================
  // 9. Frames get interactionID
  // ===========================================================================

  describe('interactionID', () => {
    it('should return an interactionID from startInteraction', async () => {
      let session = await createTestSession();
      let agent   = new MockAgent(context, []);
      let loop    = createLoop();

      let interactionID = await loop.startInteraction(session.id, defaultParams(agent));

      assert.ok(interactionID);
      assert.ok(interactionID.startsWith('int_'));
    });
  });

  // ===========================================================================
  // 10. Tool call without permission — execute and pass result back
  // ===========================================================================

  describe('tool call without permission', () => {
    it('should execute the tool and persist tool-call + tool-result frames', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'echo', arguments: { text: 'hi' } }, authorType: 'agent', authorID: 'a1' },
        { type: 'Message', content: { html: '<p>Done</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      let executedTools = [];

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (name, args) => {
          executedTools.push({ name, args });
          return 'tool output';
        },
      }));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      let toolCallFrames  = frames.filter((f) => f.type === 'ToolCall');
      let toolResultFrames = frames.filter((f) => f.type === 'ToolResult');

      assert.equal(toolCallFrames.length, 1);
      assert.equal(toolCallFrames[0].content.toolName, 'echo');
      assert.equal(toolResultFrames.length, 1);
      assert.equal(toolResultFrames[0].content.output, 'tool output');
      assert.equal(executedTools.length, 1);
      assert.equal(executedTools[0].name, 'echo');
    });
  });

  // ===========================================================================
  // 11. Tool call result is passed back to generator
  // ===========================================================================

  describe('tool result passed back to generator', () => {
    it('should pass the tool result back via generator.next()', async () => {
      let session = await createTestSession();
      let receivedResult = null;

      // Custom agent that captures the result
      class ResultCapturingAgent extends AgentInterface {
        static pluginID    = 'result-capturing';
        static featureName = 'capture';
        static agentType   = 'capture';

        async *_createGenerator(_params) {
          let result = yield { type: 'ToolCall', content: { toolName: 'test', arguments: {} }, authorType: 'agent', authorID: 'a1' };
          receivedResult = result;
          yield { type: 'Message', content: { html: `<p>Got: ${result.content.output}</p>` }, authorType: 'agent', authorID: 'a1' };
          yield { type: 'Done', content: {} };
        }
      }

      let agent = new ResultCapturingAgent(context);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: () => 'the result',
      }));

      assert.ok(receivedResult);
      assert.equal(receivedResult.type, 'ToolResult');
      assert.equal(receivedResult.content.output, 'the result');
    });
  });

  // ===========================================================================
  // 12. Permission hard-break flow
  // ===========================================================================

  describe('permission hard-break', () => {
    it('should end interaction when permission is needed', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'dangerous-tool', arguments: { x: 1 } }, authorType: 'agent', authorID: 'a1' },
        { type: 'Message', content: { html: '<p>After tool</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => {
          throw new PermissionRequiredError(toolName, { title: toolName });
        },
      }));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      // New behavior: inline permission-request frame + tool_result fed back
      // The interaction continues, so the message block IS processed
      let permRequestFrames = frames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(permRequestFrames.length, 1, 'should have a permission-request frame');
      assert.equal(permRequestFrames[0].content.toolName, 'dangerous-tool');

      let toolResultFrames = frames.filter((f) => f.type === 'ToolResult');
      assert.ok(toolResultFrames.length >= 1, 'should have a tool-result frame');
      let permResult = toolResultFrames.find((f) => f.content.output && f.content.output.includes('PERMISSION REQUIRED'));
      assert.ok(permResult, 'tool-result should contain PERMISSION REQUIRED message');

      // Interaction completes naturally (not waiting for permission)
      assert.equal(loop.isActive(session.id), false);
    });
  });

  // ===========================================================================
  // 13. Permission inline — permission-request frame
  // ===========================================================================

  describe('permission inline — permission-request frame', () => {
    it('should persist a permission-request frame with tool details', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'rm', arguments: { path: '/etc' } }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => {
          throw new PermissionRequiredError(toolName, { title: toolName });
        },
      }));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let requestFrames = frames.filter((f) => f.type === 'PermissionRequest');

      assert.equal(requestFrames.length, 1);
      assert.equal(requestFrames[0].content.toolName, 'rm');
      assert.deepEqual(requestFrames[0].content.arguments, { path: '/etc' });
    });
  });

  // ===========================================================================
  // 14. Permission hard-break creates permission-request frame
  // ===========================================================================

  describe('permission hard-break — permission-request frame', () => {
    it('should create a permission-request frame', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'sudo', arguments: {} }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => {
          throw new PermissionRequiredError(toolName, { title: toolName });
        },
      }));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let requestFrames = frames.filter((f) => f.type === 'PermissionRequest');

      assert.equal(requestFrames.length, 1);
      assert.equal(requestFrames[0].content.toolName, 'sudo');
    });
  });

  // ===========================================================================
  // 15. Generator is destroyed on permission hard-break
  // ===========================================================================

  describe('permission hard-break — generator destroyed', () => {
    it('should not be active after permission hard-break', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'exec', arguments: {} }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => {
          throw new PermissionRequiredError(toolName, { title: toolName });
        },
      }));

      // Interaction should NOT be active (generator destroyed)
      assert.equal(loop.isActive(session.id), false);
    });
  });

  // ===========================================================================
  // 16. cancelInteraction destroys generator
  // ===========================================================================

  describe('cancelInteraction', () => {
    it('should cancel and return null when no queued messages', async () => {
      let session = await createTestSession();

      // Create an agent that yields a tool-call and blocks waiting for result
      // We'll cancel while it's "running"
      let cancelledResolve;
      let cancelledPromise = new Promise((resolve) => { cancelledResolve = resolve; });

      class SlowAgent extends AgentInterface {
        static pluginID    = 'slow-agent';
        static featureName = 'slow';
        static agentType   = 'slow';

        async *_createGenerator(_params) {
          yield { type: 'Message', content: { html: '<p>Starting...</p>' }, authorType: 'agent', authorID: 'a1' };
          // This will block until generator.return() is called
          try {
            yield { type: 'ToolCall', content: { toolName: 'long-running', arguments: {} }, authorType: 'agent', authorID: 'a1' };
          } finally {
            cancelledResolve(true);
          }
        }
      }

      let agent = new SlowAgent(context);
      let loop  = createLoop();

      // Start interaction but don't await — it will block on tool call
      let interactionPromise = loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin:  agent,
        executeTool:  async () => {
          // Cancel while tool is "running"
          let queued = await loop.cancelInteraction(session.id);
          assert.equal(queued, null);
          return 'cancelled';
        },
      }));

      await interactionPromise;

      // Generator should have been cleaned up
      let cancelled = await cancelledPromise;
      assert.ok(cancelled);
    });
  });

  // ===========================================================================
  // 17. Queue: message while busy goes to queue
  // ===========================================================================

  describe('message queue — enqueue while busy', () => {
    it('should queue a message when interaction is active', async () => {
      let session = await createTestSession();

      class QueueTestAgent extends AgentInterface {
        static pluginID    = 'queue-test';
        static featureName = 'queue-test';
        static agentType   = 'queue-test';

        async *_createGenerator(_params) {
          yield { type: 'Message', content: { html: '<p>Working...</p>' }, authorType: 'agent', authorID: 'a1' };
          yield { type: 'Done', content: {} };
        }
      }

      let agent = new QueueTestAgent(context);
      let loop  = createLoop();

      // Manually set up an active interaction so queueing can be tested
      loop._active.set(session.id, { generator: null, interactionID: 'int_fake', params: {} });

      // This should queue instead of starting a new interaction
      let result = await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        userMessage: 'Queued message',
      }));

      assert.equal(result, null);

      let queued = loop.getQueuedMessages(session.id);
      assert.equal(queued.length, 1);
      assert.equal(queued[0], 'Queued message');

      // Clean up
      loop._active.delete(session.id);
      loop._queues.delete(session.id);
    });
  });

  // ===========================================================================
  // 18. Queue: multiple queued messages concatenate
  // ===========================================================================

  describe('message queue — concatenation', () => {
    it('should concatenate multiple queued messages', () => {
      let loop = createLoop();

      loop.queueMessage('ses_1', 'First message');
      loop.queueMessage('ses_1', 'Second message');
      loop.queueMessage('ses_1', 'Third message');

      let queued = loop.getQueuedMessages('ses_1');
      assert.equal(queued.length, 3);
      assert.equal(queued[0], 'First message');
      assert.equal(queued[1], 'Second message');
      assert.equal(queued[2], 'Third message');
    });
  });

  // ===========================================================================
  // 19. Queue: drains after natural completion
  // ===========================================================================

  describe('message queue — auto-drain', () => {
    it('should auto-send queued message after interaction completes', async () => {
      let session = await createTestSession();
      let interactionCount = 0;

      class CountingAgent extends AgentInterface {
        static pluginID    = 'counting';
        static featureName = 'counting';
        static agentType   = 'counting';

        async *_createGenerator(params) {
          interactionCount++;
          yield { type: 'Message', content: { html: `<p>Response ${interactionCount}</p>` }, authorType: 'agent', authorID: 'a1' };
          yield { type: 'Done', content: {} };
        }
      }

      let agent = new CountingAgent(context);
      let loop  = createLoop();

      // Pre-queue a message
      loop.queueMessage(session.id, 'Follow-up question');

      await loop.startInteraction(session.id, defaultParams(agent, { agentPlugin: agent }));

      // Should have run two interactions (original + queued)
      assert.equal(interactionCount, 2);

      // Queue should be drained
      assert.equal(loop.getQueuedMessages(session.id).length, 0);
    });
  });

  // ===========================================================================
  // 20. Inline permission-request on PermissionRequiredError
  // ===========================================================================

  describe('inline permission-request', () => {
    it('should create permission-request and tool-result inline (no hardBreak)', async () => {
      let session = await createTestSession();
      let interactionCount = 0;

      class PermissionAgent extends AgentInterface {
        static pluginID    = 'perm-agent';
        static featureName = 'perm';
        static agentType   = 'perm';

        async *_createGenerator(params) {
          interactionCount++;
          if (interactionCount === 1) {
            yield { type: 'ToolCall', content: { toolName: 'rm', arguments: { path: '/' } }, authorType: 'agent', authorID: 'a1' };
          }

          yield { type: 'Message', content: { html: '<p>Continued</p>' }, authorType: 'agent', authorID: 'a1' };
          yield { type: 'Done', content: {} };
        }
      }

      let agent = new PermissionAgent(context);
      let loop  = createLoop();

      // PermissionRequiredError in normal session => inline permission-request + tool_result
      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: (name) => {
          throw new PermissionRequiredError(name, { title: name });
        },
      }));

      // Interaction completes naturally (no hardBreak, no waiting state)
      assert.equal(interactionCount, 1);
      assert.equal(loop.isActive(session.id), false);

      // Permission-request frame and hidden tool-result should exist
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      let requestFrames = frames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1);
      assert.equal(requestFrames[0].content.toolName, 'rm');

      let toolResults = frames.filter((f) => f.type === 'ToolResult');
      let permResult  = toolResults.find((f) => f.content.output && f.content.output.includes('PERMISSION REQUIRED'));
      assert.ok(permResult, 'should have PERMISSION REQUIRED tool-result');
      assert.equal(permResult.hidden, false, 'permission tool-result should be visible (paired with ToolCall)');

      // Interaction ends on permission request — agent does NOT continue
      let messageFrames = frames.filter((f) => f.type === 'Message');
      assert.equal(messageFrames.length, 0, 'no agent message — interaction ends on permission request');
    });
  });

  // ===========================================================================
  // 21. Inline permission-request produces tool-result
  // ===========================================================================

  describe('inline permission denial', () => {
    it('should create permission-request and tool-result inline when permission needed in normal session', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'sudo', arguments: {} }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => {
          throw new PermissionRequiredError(toolName, { title: toolName });
        },
      }));

      // New behavior: no hardBreak in normal sessions, interaction completes inline
      assert.equal(loop.isActive(session.id), false);

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      // Permission-request frame should exist
      let requestFrames = frames.filter((f) => f.type === 'PermissionRequest');
      assert.ok(requestFrames.length >= 1, 'should have a permission-request frame');
      assert.equal(requestFrames[0].content.toolName, 'sudo');

      // Tool-result with PERMISSION REQUIRED should exist
      let toolResults = frames.filter((f) => f.type === 'ToolResult');
      let permResult  = toolResults.find((f) => f.content.output && f.content.output.includes('PERMISSION REQUIRED'));
      assert.ok(permResult, 'should have PERMISSION REQUIRED tool-result');
    });
  });

  // ===========================================================================
  // 22. Event emission: frame event
  // ===========================================================================

  describe('event emission — frame', () => {
    it('should emit frame events for each created frame', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Message', content: { html: '<p>Hello</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent  = new MockAgent(context, blocks);
      let loop   = createLoop();
      let events = [];

      loop.on('frame', (event) => events.push(event));

      await loop.startInteraction(session.id, defaultParams(agent));

      // Should have at least 2 frame events: user-message + message
      assert.ok(events.length >= 2, `Expected >= 2 frame events, got ${events.length}`);
      assert.equal(events[0].frame.type, 'UserMessage');
      assert.equal(events[1].frame.type, 'Message');

      // All events should have sessionID
      for (let event of events)
        assert.equal(event.sessionID, session.id);
    });
  });

  // ===========================================================================
  // 23. Event emission: interaction start/end
  // ===========================================================================

  describe('event emission — interaction lifecycle', () => {
    it('should emit interaction:start and interaction:end', async () => {
      let session    = await createTestSession();
      let agent      = new MockAgent(context, []);
      let loop       = createLoop();
      let startEvents = [];
      let endEvents   = [];

      loop.on('interaction:start', (event) => startEvents.push(event));
      loop.on('interaction:end', (event) => endEvents.push(event));

      await loop.startInteraction(session.id, defaultParams(agent));

      assert.equal(startEvents.length, 1);
      assert.equal(endEvents.length, 1);
      assert.equal(startEvents[0].sessionID, session.id);
      assert.equal(endEvents[0].sessionID, session.id);
      assert.ok(startEvents[0].interactionID);
      assert.equal(startEvents[0].interactionID, endEvents[0].interactionID);
    });
  });

  // ===========================================================================
  // 24. Interaction with no blocks (just done)
  // ===========================================================================

  describe('empty interaction', () => {
    it('should complete cleanly when agent yields only done', async () => {
      let session = await createTestSession();
      let agent   = new MockAgent(context, []);
      let loop    = createLoop();

      let interactionID = await loop.startInteraction(session.id, defaultParams(agent));

      assert.ok(interactionID);
      assert.equal(loop.isActive(session.id), false);

      // Only user-message frame should exist
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let userFrames = frames.filter((f) => f.type === 'UserMessage');

      assert.equal(userFrames.length, 1);
      assert.equal(frames.filter((f) => f.type === 'Message').length, 0);
    });
  });

  // ===========================================================================
  // 25. Multiple sequential interactions on same session
  // ===========================================================================

  describe('multiple sequential interactions', () => {
    it('should support multiple interactions on the same session', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Message', content: { html: '<p>Response</p>' }, authorType: 'agent', authorID: 'a1' },
      ];

      let loop = createLoop();

      // First interaction
      let agent1 = new MockAgent(context, blocks);
      let id1    = await loop.startInteraction(session.id, defaultParams(agent1, { agentPlugin: agent1, userMessage: 'First' }));

      // Second interaction
      let agent2 = new MockAgent(context, blocks);
      let id2    = await loop.startInteraction(session.id, defaultParams(agent2, { agentPlugin: agent2, userMessage: 'Second' }));

      assert.ok(id1);
      assert.ok(id2);
      assert.notEqual(id1, id2);

      // Both interactions' frames should be persisted
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let userFrames    = frames.filter((f) => f.type === 'UserMessage');
      let messageFrames = frames.filter((f) => f.type === 'Message');

      assert.equal(userFrames.length, 2);
      assert.equal(messageFrames.length, 2);
    });
  });

  // ===========================================================================
  // 26. isActive returns correct state
  // ===========================================================================

  describe('state queries', () => {
    it('should report not active when no interaction running', () => {
      let loop = createLoop();
      assert.equal(loop.isActive('ses_nonexistent'), false);
    });
  });

  // ===========================================================================
  // 27. sessionID is required for startInteraction
  // ===========================================================================

  describe('validation', () => {
    it('should throw when sessionID is missing', async () => {
      let loop = createLoop();
      await assert.rejects(
        () => loop.startInteraction(null, {}),
        { message: /sessionID is required/ },
      );
    });
  });

  // ===========================================================================
  // 28. Permission events are emitted
  // ===========================================================================

  describe('permission:request event', () => {
    it('should emit permission:request when permission is needed', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'nuclear', arguments: {} }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent  = new MockAgent(context, blocks);
      let loop   = createLoop();
      let events = [];

      loop.on('permission:request', (event) => events.push(event));

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => {
          throw new PermissionRequiredError(toolName, { title: toolName });
        },
      }));

      assert.equal(events.length, 1);
      assert.equal(events[0].sessionID, session.id);
      assert.equal(events[0].toolName, 'nuclear');
      assert.ok(events[0].frameID);
    });
  });

  // ===========================================================================
  // 29. Tool executes directly when no permission error thrown
  // ===========================================================================

  describe('direct tool execution', () => {
    it('should execute tool directly when no permission error thrown', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'test', arguments: {} }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();
      let toolRan = false;

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => { toolRan = true; return 'ok'; },
      }));

      assert.ok(toolRan);
    });
  });

  // Tests 30-31 (legacy approvePermission/denyPermission) removed — those
  // flows are now handled by PermissionApprovalPlugin via FrameRouter.

  // ===========================================================================
  // Failure & adversarial tests
  // ===========================================================================

  describe('agent generator throws', () => {
    it('should emit error frame when generator throws during iteration', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      class ThrowingAgent extends AgentInterface {
        static pluginID    = 'throwing';
        static featureName = 'throwing';
        static agentType   = 'throwing';

        async *_createGenerator(_params) {
          yield { type: 'Message', content: { html: '<p>Starting</p>' }, authorType: 'agent', authorID: 'a1' };
          throw new Error('generator exploded');
        }
      }

      let agent         = new ThrowingAgent(context);
      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent, { agentPlugin: agent }));

      let errorFrames = emittedFrames.filter((f) => f.type === 'Error');
      assert.ok(errorFrames.length >= 1);
      assert.ok(errorFrames[0].content.message.includes('generator exploded'));
    });

    it('should end interaction cleanly after generator error', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      class FailAgent extends AgentInterface {
        static pluginID    = 'fail';
        static featureName = 'fail';
        static agentType   = 'fail';

        async *_createGenerator(_params) {
          throw new Error('immediate failure');
        }
      }

      let agent     = new FailAgent(context);
      let endEvents = [];
      loop.on('interaction:end', (ev) => endEvents.push(ev));

      await loop.startInteraction(session.id, defaultParams(agent, { agentPlugin: agent }));

      assert.equal(loop.isActive(session.id), false);
      assert.equal(endEvents.length, 1);
    });
  });

  describe('unknown block type from generator', () => {
    it('should handle unknown block types without crashing', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'unknown-type', content: { data: 'mystery' }, authorType: 'agent', authorID: 'a1' },
        { type: 'Message', content: { html: '<p>After unknown</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent));

      // Should still process the message after the unknown type
      let messageFrames = emittedFrames.filter((f) => f.type === 'Message');
      assert.ok(messageFrames.length >= 1);
      assert.ok(messageFrames[0].content.html.includes('After unknown'));
    });
  });

  describe('cancelInteraction on non-active session', () => {
    it('should return null when cancelling a session with no active interaction', async () => {
      let loop   = createLoop();
      let result = await loop.cancelInteraction('ses_does_not_exist');
      assert.equal(result, null);
    });
  });

  describe('startInteraction with empty string message', () => {
    it('should handle empty string userMessage', async () => {
      let session = await createTestSession();
      let agent   = new MockAgent(context, []);
      let loop    = createLoop();

      // Should not crash — empty messages are valid (might be used for replays)
      let interactionID = await loop.startInteraction(session.id, defaultParams(agent, {
        userMessage: '',
      }));

      assert.ok(interactionID);
    });
  });

  describe('tool returns null/undefined', () => {
    it('should handle executeTool returning null', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'null-tool', arguments: {} }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => null,
      }));

      let resultFrames = emittedFrames.filter((f) => f.type === 'ToolResult');
      assert.ok(resultFrames.length >= 1);
      // null should be converted to something passable to generator
      assert.equal(resultFrames[0].content.output, null);
    });

    it('should handle executeTool returning undefined', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'ToolCall', content: { toolName: 'void-tool', arguments: {} }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => undefined,
      }));

      // Should complete without error
      assert.equal(loop.isActive(session.id), false);
    });
  });

  describe('getQueuedMessages on empty queue', () => {
    it('should return empty array for session with no queued messages', () => {
      let loop   = createLoop();
      let queued = loop.getQueuedMessages('ses_no_queue');
      assert.deepEqual(queued, []);
    });
  });

  describe('double permission-request inline', () => {
    it('should handle multiple permission-required errors inline', async () => {
      let session = await createTestSession();
      let permissionCount = 0;

      // Agent that yields two tool-calls, both of which trigger permission errors
      class DoubleToolAgent extends AgentInterface {
        static pluginID    = 'double-tool';
        static featureName = 'double-tool';
        static agentType   = 'double-tool';

        async *_createGenerator(_params) {
          yield { type: 'ToolCall', content: { toolName: 'exec', arguments: {} }, authorType: 'agent', authorID: 'a1' };
          yield { type: 'ToolCall', content: { toolName: 'exec2', arguments: {} }, authorType: 'agent', authorID: 'a1' };
          yield { type: 'Done', content: {} };
        }
      }

      let agent = new DoubleToolAgent(context);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: (toolName) => {
          permissionCount++;
          throw new PermissionRequiredError(toolName, { title: toolName });
        },
      }));

      // First permission request breaks the interaction — only 1 fires
      assert.equal(loop.isActive(session.id), false);
      assert.equal(permissionCount, 1, 'interaction ends on first permission request');

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      let requestFrames = frames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1, 'should have 1 permission-request frame (interaction ended)');
    });
  });

  // ===========================================================================
  // Phase 3: Hook integration
  // ===========================================================================

  describe('hook integration — prepareMessage', () => {
    beforeEach(() => {
      // Clear all registered hooks between tests to prevent leakage
      let registry = context.getProperty('pluginRegistry');
      if (registry && registry._hooks)
        registry._hooks.clear();
    });

    it('should fire user→agent hook and block message', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      // Register a blocking hook
      let registry = context.getProperty('pluginRegistry');
      registry.registerHook('prepareMessage', (payload) => {
        if (payload.source === 'user' && payload.target === 'agent')
          return { action: 'block', reason: 'filtered' };

        return null;
      });

      let blocks = [
        { type: 'Message', content: { html: '<p>Should not run</p>' }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent));

      // Should have a hook-blocked frame
      let blockedFrames = emittedFrames.filter((f) => f.type === 'HookBlocked');
      assert.ok(blockedFrames.length >= 1);
      assert.ok(blockedFrames[0].content.reason.includes('filtered'));

      // Should NOT have agent message frames
      let messageFrames = emittedFrames.filter((f) => f.type === 'Message');
      assert.equal(messageFrames.length, 0);
    });

    it('should fire agent→user hook and modify message', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let registry = context.getProperty('pluginRegistry');
      registry.registerHook('prepareMessage', (payload) => {
        if (payload.source === 'agent' && payload.target === 'user')
          return { action: 'modify', message: payload.message + ' [hooked]' };

        return null;
      });

      let blocks = [
        { type: 'Message', content: { html: '<p>Hello</p>' }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent));

      let messageFrames = emittedFrames.filter((f) => f.type === 'Message');
      assert.ok(messageFrames.length >= 1);
      assert.ok(messageFrames[0].content.html.includes('[hooked]'));
    });

    it('should fire agent→tool hook and block tool execution', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let toolRan = false;

      let registry = context.getProperty('pluginRegistry');
      registry.registerHook('prepareMessage', (payload) => {
        if (payload.source === 'agent' && payload.target === 'tool')
          return { action: 'block', reason: 'tool blocked' };

        return null;
      });

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'shell:execute', arguments: { command: 'ls' } }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => { toolRan = true; return 'output'; },

      }));

      assert.equal(toolRan, false);
    });

    it('should fire tool→agent hook and modify tool output', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let registry = context.getProperty('pluginRegistry');
      registry.registerHook('prepareMessage', (payload) => {
        if (payload.source === 'tool' && payload.target === 'agent')
          return { action: 'modify', message: payload.message + ' [filtered]' };

        return null;
      });

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'shell:execute', arguments: { command: 'ls' } }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => 'file1.txt',

      }));

      let resultFrames = emittedFrames.filter((f) => f.type === 'ToolResult');
      assert.ok(resultFrames.length >= 1);
      assert.ok(resultFrames[0].content.output.includes('[filtered]'));
    });

    it('should work normally when no hooks registered', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        { type: 'Message', content: { html: '<p>Hello</p>' }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent));

      let messageFrames = emittedFrames.filter((f) => f.type === 'Message');
      assert.ok(messageFrames.length >= 1);
    });
  });

  // ===========================================================================
  // Phase 3: PermissionDeniedError handling
  // ===========================================================================

  describe('PermissionDeniedError handling', () => {
    beforeEach(() => {
      let registry = context.getProperty('pluginRegistry');
      if (registry && registry._hooks)
        registry._hooks.clear();
    });

    it('should create permission-denied frame when executeTool throws PermissionDeniedError', async () => {
      let { PermissionDeniedError } = await import('../../src/core/permissions/permission-denied-error.mjs');

      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'dangerous:tool', arguments: {} }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => {
          throw new PermissionDeniedError('dangerous:tool', 'explicit deny');
        },
      }));

      let deniedFrames = emittedFrames.filter((f) => f.type === 'PermissionDenied');
      assert.ok(deniedFrames.length >= 1);
      assert.equal(deniedFrames[0].content.toolName, 'dangerous:tool');
    });

    it('should pass error result to generator on PermissionDeniedError', async () => {
      let { PermissionDeniedError } = await import('../../src/core/permissions/permission-denied-error.mjs');

      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'blocked:tool', arguments: {} }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => {
          throw new PermissionDeniedError('blocked:tool', 'deny rule');
        },
      }));

      // The tool-call block should have received the error result
      let toolBlock = blocks[0];
      assert.ok(toolBlock._receivedResult);
      assert.ok(toolBlock._receivedResult.content.output.includes('Permission denied'));
    });

    it('should create tool-error frame for non-permission errors from executeTool', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'test:tool', arguments: {} }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: () => { throw new Error('DB connection lost'); },
      }));

      // Should produce a tool-error frame (executeTool error handler)
      let errorFrames = emittedFrames.filter((f) => f.type === 'ToolError');
      assert.ok(errorFrames.length >= 1);
      assert.ok(errorFrames[0].content.message.includes('DB connection lost'));
    });
  });

  // ===========================================================================
  // Phase 3: Tool execution error recovery
  // ===========================================================================

  describe('tool execution error recovery', () => {
    beforeEach(() => {
      let registry = context.getProperty('pluginRegistry');
      if (registry && registry._hooks)
        registry._hooks.clear();
    });

    it('should create tool-error frame when executeTool throws', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'shell:execute', arguments: { command: 'ls' } }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent, {

        executeTool: () => { throw new Error('command not found'); },
      }));

      let errorFrames = emittedFrames.filter((f) => f.type === 'ToolError');
      assert.ok(errorFrames.length >= 1);
      assert.equal(errorFrames[0].content.toolName, 'shell:execute');
      assert.ok(errorFrames[0].content.message.includes('command not found'));
    });

    it('should pass error text to generator instead of killing interaction', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'shell:execute', arguments: { command: 'bad' } }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      await loop.startInteraction(session.id, defaultParams(agent, {

        executeTool: () => { throw new Error('exec failed'); },
      }));

      let toolBlock = blocks[0];
      assert.ok(toolBlock._receivedResult);
      assert.ok(toolBlock._receivedResult.content.output.includes('Error executing tool'));
    });

    it('should NOT create interaction-level error frame on tool error', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'shell:execute', arguments: { command: 'x' } }, authorType: 'agent' },
      ];
      let agent = new MockAgent(context, blocks);

      let emittedFrames = [];
      loop.on('frame', ({ frame }) => emittedFrames.push(frame));

      await loop.startInteraction(session.id, defaultParams(agent, {

        executeTool: () => { throw new Error('tool fail'); },
      }));

      // Should have tool-error but NOT interaction-level error
      let toolErrors = emittedFrames.filter((f) => f.type === 'ToolError');
      let errors     = emittedFrames.filter((f) => f.type === 'Error');
      assert.ok(toolErrors.length >= 1);
      assert.equal(errors.length, 0);
    });
  });

  // ===========================================================================
  // Phase 3: _buildMessages defense-in-depth
  // ===========================================================================

  // ===========================================================================
  // interaction:usage event on done block
  // ===========================================================================

  describe('interaction:usage event', () => {
    it('should emit interaction:usage when done block has usage data', async () => {
      let session = await createTestSession();
      let blocks  = [
        { type: 'Message', content: { html: '<p>Hello!</p>' }, authorType: 'agent', authorID: 'agent_1' },
        { type: 'Done', content: { usage: { inputTokens: 100, outputTokens: 50 } } },
      ];

      // Override MockAgent to yield done with usage instead of default empty done
      class UsageAgent extends AgentInterface {
        static pluginID    = 'usage-agent';
        static featureName = 'mock';
        static displayName = 'Usage Agent';
        static description = 'Mock agent with usage';
        static agentType   = 'mock';

        async *_createGenerator(_params) {
          yield { type: 'Message', content: { html: '<p>Hello!</p>' }, authorType: 'agent', authorID: 'agent_1' };
          yield { type: 'Done', content: { usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 80, cacheCreationInputTokens: 20 } } };
        }
      }

      let agent = new UsageAgent(context);
      let loop  = createLoop();

      let usageEvents = [];
      loop.on('interaction:usage', (event) => usageEvents.push(event));

      await loop.startInteraction(session.id, defaultParams(agent));

      assert.equal(usageEvents.length, 1);
      assert.equal(usageEvents[0].sessionID, session.id);
      assert.ok(usageEvents[0].interactionID);
      assert.equal(usageEvents[0].usage.inputTokens, 100);
      assert.equal(usageEvents[0].usage.outputTokens, 50);
      assert.equal(usageEvents[0].usage.cacheReadInputTokens, 80);
      assert.equal(usageEvents[0].usage.cacheCreationInputTokens, 20);
    });

    it('should NOT emit interaction:usage when done block has no usage', async () => {
      let session = await createTestSession();
      let agent   = new MockAgent(context, [
        { type: 'Message', content: { html: '<p>Hi</p>' }, authorType: 'agent' },
      ]);
      let loop = createLoop();

      let usageEvents = [];
      loop.on('interaction:usage', (event) => usageEvents.push(event));

      await loop.startInteraction(session.id, defaultParams(agent));

      assert.equal(usageEvents.length, 0);
    });
  });

  describe('_buildMessages defense-in-depth', () => {
    it('should skip deleted frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' }, deleted: false },
        { type: 'Message', content: { html: '<p>hi</p>' }, deleted: true },
        { type: 'UserMessage', content: { text: 'world' }, deleted: false },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, 'hello');
      assert.equal(messages[1].content, 'world');
    });

    it('should include pending-action frames as tool-call messages when resolved', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'PendingAction', content: { toolName: 'shell', arguments: {}, toolUseID: 'toolu_123' } },
        { type: 'ToolResult', content: { output: 'done', toolUseID: 'toolu_123' } },
        { type: 'Message', content: { html: '<p>hi</p>' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 4);
      assert.equal(messages[1].type, 'ToolCall');
      assert.equal(messages[1].content.toolName, 'shell');
      assert.equal(messages[1].content.toolUseID, 'toolu_123');
      assert.equal(messages[2].type, 'ToolResult');
    });

    it('should skip pending-action frames without matching tool-result', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'PendingAction', content: { toolName: 'shell', arguments: {}, toolUseID: 'toolu_orphan' } },
        { type: 'Message', content: { html: '<p>hi</p>' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'assistant');
    });

    it('should skip permission-request frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'PermissionRequest', content: { toolName: 'shell' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 1);
    });

    it('should skip permission-denied frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'PermissionDenied', content: { pendingFrameID: 'frm_123' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 1);
    });

    it('should skip hook-blocked frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'HookBlocked', content: { reason: 'test' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 1);
    });

    it('should skip tool-error frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'ToolError', content: { message: 'fail' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 1);
    });

    it('should include tool-call and tool-result frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'ToolCall', content: { toolName: 'shell', arguments: {} } },
        { type: 'ToolResult', content: { output: 'result' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].type, 'ToolCall');
      assert.equal(messages[1].type, 'ToolResult');
    });

    it('should skip error frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'Error', content: { message: 'oops' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 1);
    });

    it('should skip reflection frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'Reflection', content: { text: 'thinking' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 1);
    });

    it('should return empty array for empty frames', () => {
      let loop     = createLoop();
      let messages = loop._buildMessages([]);
      assert.deepEqual(messages, []);
    });

    it('should return empty array when all frames are excluded types', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'PermissionRequest', content: { toolName: 'shell' } },
        { type: 'PermissionDenied', content: {} },
        { type: 'HookBlocked', content: { reason: 'test' } },
        { type: 'ToolError', content: { message: 'fail' } },
        { type: 'Error', content: { message: 'oops' } },
        { type: 'Reflection', content: { text: 'thinking' } },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 0);
    });
  });

});
