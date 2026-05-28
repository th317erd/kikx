'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../src/core/index.mjs';
import { InteractionLoop }    from '../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }     from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Phase D3 — Enriched commit events
// =============================================================================
// Verifies that InteractionLoop._createFrame() emits commit events with the
// frame data embedded (the `frames` array), so clients can merge() directly.
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

  async *_createGenerator() {
    for (let block of this._blocks)
      yield block;

    yield { type: 'Done', content: {} };
  }
}

describe('InteractionLoop enriched commit events (D3)', () => {
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

  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'D3 Org' });
    let session = await sessionManager.createSession(org.id, { name: 'D3 Test' });
    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  it('commit event includes frames array with the created frame data', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let commits = [];

    loop.on('commit', (data) => commits.push(data));

    let agentPlugin = {
      async execute(params) {
        let agent = new MockAgent(context, [
          { type: 'Message', content: { html: '<p>hello</p>' }, authorType: 'agent', authorID: 'agt_1' },
        ]);

        return agent.execute(params);
      },
    };

    await loop.startInteraction(session.id, {
      userMessage: 'test message',
      agentPlugin,
      agent:       { id: 'agt_1' },
      authorType:  'user',
      authorID:    'usr_1',
    });

    // Should have commits: user-message frame + agent message frame (at minimum)
    assert.ok(commits.length >= 2, `Expected at least 2 commits, got ${commits.length}`);

    // Every commit should have a frames array
    for (let commitData of commits) {
      assert.ok(Array.isArray(commitData.commit.frames), 'commit should have frames array');
      assert.ok(commitData.commit.frames.length > 0, 'frames array should not be empty');
    }

    // The first commit should be the user-message
    let firstCommit = commits[0];
    assert.equal(firstCommit.sessionID, session.id);
    assert.equal(firstCommit.commit.frames[0].type, 'UserMessage');
    assert.ok(firstCommit.commit.frames[0].id, 'frame should have an id');
  });

  it('enriched commit preserves standard commit fields', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let commits = [];

    loop.on('commit', (data) => commits.push(data));

    let agentPlugin = {
      async execute(params) {
        let agent = new MockAgent(context, [
          { type: 'Message', content: { html: '<p>test</p>' }, authorType: 'agent' },
        ]);

        return agent.execute(params);
      },
    };

    await loop.startInteraction(session.id, {
      userMessage: 'hi',
      agentPlugin,
      agent:       { id: 'agt_2' },
      authorType:  'user',
    });

    let commit = commits[0].commit;

    // Standard commit fields should still be present
    assert.ok(typeof commit.order === 'number');
    assert.ok(Array.isArray(commit.changes));
    assert.ok(typeof commit.authorType === 'string');
    assert.ok(typeof commit.timestamp === 'number');
    assert.ok(typeof commit.silent === 'boolean');

    // Plus the enriched frames
    assert.ok(Array.isArray(commit.frames));
  });

  it('frame data in commit matches the frame event data', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let frames  = [];
    let commits = [];

    loop.on('frame', (data) => frames.push(data));
    loop.on('commit', (data) => commits.push(data));

    let agentPlugin = {
      async execute(params) {
        let agent = new MockAgent(context, []);
        return agent.execute(params);
      },
    };

    await loop.startInteraction(session.id, {
      userMessage: 'match test',
      agentPlugin,
      agent:       { id: 'agt_3' },
      authorType:  'user',
    });

    // The first frame event and first commit should reference the same frame
    assert.ok(frames.length > 0, 'should have at least one frame event');
    assert.ok(commits.length > 0, 'should have at least one commit event');

    let frameFromEvent  = frames[0].frame;
    let frameFromCommit = commits[0].commit.frames[0];

    assert.equal(frameFromEvent.id, frameFromCommit.id);
    assert.equal(frameFromEvent.type, frameFromCommit.type);
  });
});
