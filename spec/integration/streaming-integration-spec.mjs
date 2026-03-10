'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../src/core/index.mjs';
import { InteractionLoop }    from '../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }     from '../../src/core/plugins/agent-interface.mjs';
import { FrameManager }       from '../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Phase D6 — Streaming Integration Tests
// =============================================================================
// End-to-end test of the commit streaming pipeline:
//   InteractionLoop → enriched commit event → client FrameManager merge
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-streaming';
  static featureName = 'mock';
  static displayName = 'Mock Streaming Agent';
  static description = 'Mock agent for streaming integration tests';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks = blocks || [];
  }

  async *_createGenerator() {
    for (let block of this._blocks) {
      if (block.type === 'tool-call') {
        let result = yield block;
        block._receivedResult = result;
      } else {
        yield block;
      }
    }

    yield { type: 'done', content: {} };
  }
}

describe('Streaming Integration (D6)', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', new ContentSanitizer());
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestSession(name) {
    let org     = await models.Organization.create({ name: `D6 Org ${name}` });
    let session = await sessionManager.createSession(org.id, { name });
    return session;
  }

  function createAgentPlugin(blocks) {
    return {
      async execute(params) {
        let agent = new MockAgent(context, blocks);
        return agent.execute(params);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline: InteractionLoop → commit → client FrameManager
  // ---------------------------------------------------------------------------

  describe('full pipeline', () => {
    it('commit events can be consumed by a client-side FrameManager', async () => {
      let session = await createTestSession('pipeline');
      let loop    = createLoop();

      // Simulate client-side FrameManager
      let clientFrameManager = new FrameManager({ history: false });
      let addedFrames        = [];

      clientFrameManager.on('frame:added', ({ frame }) => {
        addedFrames.push(frame);
      });

      // Capture commit events and feed them to client FrameManager
      loop.on('commit', ({ commit }) => {
        if (commit.frames)
          clientFrameManager.merge(commit.frames);
      });

      let agentPlugin = createAgentPlugin([
        { type: 'message', content: { html: '<p>Hello from agent</p>' }, authorType: 'agent' },
      ]);

      await loop.startInteraction(session.id, {
        userMessage: 'Hi there',
        agentPlugin,
        agent:       { id: 'agt_stream_1' },
        authorType:  'user',
        authorID:    'usr_1',
      });

      // Client FrameManager should have received frames via commit events
      let allFrames = clientFrameManager.toArray();
      assert.ok(allFrames.length >= 2, `Expected at least 2 frames, got ${allFrames.length}`);

      // Should have user-message and agent message
      let types = allFrames.map((f) => f.type);
      assert.ok(types.includes('user-message'), 'Should have user-message frame');
      assert.ok(types.includes('message'), 'Should have agent message frame');

      // frame:added events should have fired
      assert.ok(addedFrames.length >= 2, `Expected at least 2 frame:added events, got ${addedFrames.length}`);
    });

    it('multiple rapid messages produce ordered commits', async () => {
      let session = await createTestSession('rapid');
      let loop    = createLoop();
      let commits = [];

      loop.on('commit', ({ commit }) => {
        commits.push(commit);
      });

      // First interaction
      let agentPlugin1 = createAgentPlugin([
        { type: 'message', content: { html: '<p>Response 1</p>' }, authorType: 'agent' },
      ]);

      await loop.startInteraction(session.id, {
        userMessage: 'Message 1',
        agentPlugin: agentPlugin1,
        agent:       { id: 'agt_rapid_1' },
        authorType:  'user',
      });

      let firstBatchCount = commits.length;

      // Second interaction (same session)
      let agentPlugin2 = createAgentPlugin([
        { type: 'message', content: { html: '<p>Response 2</p>' }, authorType: 'agent' },
      ]);

      await loop.startInteraction(session.id, {
        userMessage: 'Message 2',
        agentPlugin: agentPlugin2,
        agent:       { id: 'agt_rapid_1' },
        authorType:  'user',
      });

      assert.ok(commits.length > firstBatchCount, 'Second interaction should produce more commits');

      // All commits should have incrementing orders
      for (let i = 1; i < commits.length; i++)
        assert.ok(commits[i].order > commits[i - 1].order, 'Commit orders should be increasing');
    });

    it('client FrameManager state is consistent after multiple interactions', async () => {
      let session = await createTestSession('consistency');
      let loop    = createLoop();

      let clientFrameManager = new FrameManager({ history: false });

      loop.on('commit', ({ commit }) => {
        if (commit.frames)
          clientFrameManager.merge(commit.frames);
      });

      // Run 3 interactions sequentially
      for (let i = 1; i <= 3; i++) {
        let agentPlugin = createAgentPlugin([
          { type: 'message', content: { html: `<p>Response ${i}</p>` }, authorType: 'agent' },
        ]);

        await loop.startInteraction(session.id, {
          userMessage: `Message ${i}`,
          agentPlugin,
          agent:       { id: 'agt_consistency' },
          authorType:  'user',
        });
      }

      // Should have 6 frames: 3 user messages + 3 agent responses
      let allFrames = clientFrameManager.toArray();
      assert.ok(allFrames.length >= 6, `Expected at least 6 frames, got ${allFrames.length}`);

      // Frames should be ordered
      for (let i = 1; i < allFrames.length; i++)
        assert.ok(allFrames[i].order > allFrames[i - 1].order, 'Frames should be ordered');

      // No duplicate frame IDs
      let ids = new Set(allFrames.map((f) => f.id));
      assert.equal(ids.size, allFrames.length, 'No duplicate frame IDs');
    });
  });

  // ---------------------------------------------------------------------------
  // Bulk load + live stream combination
  // ---------------------------------------------------------------------------

  describe('bulk load + live stream', () => {
    it('client can bulk-load existing frames then receive live commits', async () => {
      let session = await createTestSession('bulk+live');
      let loop    = createLoop();

      // First interaction: create some historical frames
      let agentPlugin1 = createAgentPlugin([
        { type: 'message', content: { html: '<p>Historical response</p>' }, authorType: 'agent' },
      ]);

      await loop.startInteraction(session.id, {
        userMessage: 'Historical message',
        agentPlugin: agentPlugin1,
        agent:       { id: 'agt_bulk' },
        authorType:  'user',
      });

      // Simulate client: bulk-load from DB
      let clientFrameManager = new FrameManager({ history: false });
      await framePersistence.loadFramesInto(clientFrameManager, session.id);
      clientFrameManager.syncOrderCounter(clientFrameManager.getWindowBounds().to);

      let initialCount = clientFrameManager.toArray().length;
      assert.ok(initialCount >= 2, 'Should have at least 2 historical frames');

      // Now subscribe to live commits
      let liveFrames = [];
      loop.on('commit', ({ commit }) => {
        if (commit.frames)
          clientFrameManager.merge(commit.frames);
      });

      clientFrameManager.on('frame:added', ({ frame }) => {
        liveFrames.push(frame);
      });

      // Second interaction: live frames
      let agentPlugin2 = createAgentPlugin([
        { type: 'message', content: { html: '<p>Live response</p>' }, authorType: 'agent' },
      ]);

      await loop.startInteraction(session.id, {
        userMessage: 'Live message',
        agentPlugin: agentPlugin2,
        agent:       { id: 'agt_bulk' },
        authorType:  'user',
      });

      let finalCount = clientFrameManager.toArray().length;
      assert.ok(finalCount > initialCount, 'Should have more frames after live interaction');
      assert.ok(liveFrames.length >= 2, 'Should have received live frame:added events');
    });
  });

  // ---------------------------------------------------------------------------
  // Enriched commit structure
  // ---------------------------------------------------------------------------

  describe('enriched commit structure', () => {
    it('every commit has frames array with full frame data', async () => {
      let session = await createTestSession('structure');
      let loop    = createLoop();
      let commits = [];

      loop.on('commit', ({ commit }) => commits.push(commit));

      let agentPlugin = createAgentPlugin([
        { type: 'message', content: { html: '<p>test</p>' }, authorType: 'agent' },
      ]);

      await loop.startInteraction(session.id, {
        userMessage: 'test',
        agentPlugin,
        agent:       { id: 'agt_struct' },
        authorType:  'user',
      });

      for (let commit of commits) {
        assert.ok(typeof commit.order === 'number', 'commit.order should be a number');
        assert.ok(Array.isArray(commit.frames), 'commit.frames should be an array');
        assert.ok(commit.frames.length > 0, 'commit.frames should not be empty');

        for (let frame of commit.frames) {
          assert.ok(frame.id, 'frame should have an id');
          assert.ok(frame.type, 'frame should have a type');
          assert.ok(frame.content !== undefined, 'frame should have content');
        }
      }
    });
  });

  function createLoop() {
    return new InteractionLoop(context);
  }
});
