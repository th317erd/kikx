'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }      from '../../src/core/index.mjs';
import { InteractionLoop }     from '../../src/core/interaction/index.mjs';
import { SessionManager }      from '../../src/core/session/index.mjs';
import { FramePersistence }    from '../../src/core/frames/index.mjs';
import { ContentSanitizer }    from '../../src/core/lib/content-sanitizer.mjs';
import { SessionScheduler }    from '../../src/core/scheduling/session-scheduler.mjs';
import { AgentInterface }      from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Phase B7 — Controller + Transport Integration
// =============================================================================
// Tests that the scheduler integrates correctly with InteractionLoop in a
// realistic multi-component setup.
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

describe('Scheduler Integration (B7)', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;
  let scheduler;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    interactionLoop  = new InteractionLoop(context);

    scheduler = new SessionScheduler({
      sessionManager,
      interactionLoop,
    });

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', new ContentSanitizer());
    context.setProperty('interactionLoop', interactionLoop);
    context.setProperty('sessionScheduler', scheduler);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestSetup() {
    let org     = await models.Organization.create({ name: 'B7 Org' });
    let agent   = await models.Agent.create({ organizationID: org.id, name: 'test-b7-agent', pluginID: 'mock' });
    let session = await sessionManager.createSession(org.id, { name: 'B7 Test' });

    await sessionManager.addParticipant(session.id, agent.id);

    return { org, agent, session };
  }

  // ---------------------------------------------------------------------------
  // Single-agent backward compat via scheduler
  // ---------------------------------------------------------------------------

  it('should work identically for single-agent sessions', async () => {
    let { agent, session } = await createTestSetup();
    let mockPlugin = new MockAgent(context, [
      { type: 'message', content: { html: '<p>Hello</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    // Use InteractionLoop directly (single-agent path unchanged)
    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockPlugin,
      agent:       { id: agent.id, name: 'test-b7-agent', pluginID: 'mock' },
      userMessage: 'Test message',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let allFrames    = frameManager.toArray();

    // Should have user-message + agent message
    let userFrame  = allFrames.find((f) => f.type === 'user-message');
    let agentFrame = allFrames.find((f) => f.type === 'message');

    assert.ok(userFrame);
    assert.ok(agentFrame);
  });

  it('should detect multiple participants needing triggering', async () => {
    let org     = await models.Organization.create({ name: 'B7 Multi Org' });
    let agentA  = await models.Agent.create({ organizationID: org.id, name: 'test-b7-a', pluginID: 'mock' });
    let agentB  = await models.Agent.create({ organizationID: org.id, name: 'test-b7-b', pluginID: 'mock' });
    let session = await sessionManager.createSession(org.id, { name: 'B7 Multi' });

    await sessionManager.addParticipant(session.id, agentA.id);
    await sessionManager.addParticipant(session.id, agentB.id);

    // Simulate user message
    let frameManager = sessionManager.getFrameManager(session.id);
    frameManager.merge([{
      id: 'frm_b7m_1', type: 'user-message', content: { text: 'Hello agents' },
      authorType: 'user', authorID: 'usr_1',
    }], { authorType: 'user', authorID: 'usr_1' });

    let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

    assert.equal(scheduled.length, 2, 'Both agents should be scheduled');
  });

  it('should not trigger agent on its own commit after interaction', async () => {
    let { agent, session } = await createTestSetup();
    let mockPlugin = new MockAgent(context, [
      { type: 'message', content: { html: '<p>Reply</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    // Run interaction — produces user-message and agent-message commits
    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockPlugin,
      agent:       { id: agent.id, name: 'test-b7-agent', pluginID: 'mock' },
      userMessage: 'Trigger loop test',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let latestCommit = frameManager.getLatestCommit();

    // The latest commit should be from the agent — scheduler should NOT trigger it
    let scheduled = await scheduler.onCommit(session.id, latestCommit);

    // Agent should be skipped (self-authored OR already caught-up because ref was advanced)
    assert.equal(scheduled.length, 0, 'Agent should not be triggered on its own commit');
  });

  it('should provide sessionScheduler via context', () => {
    let fromContext = context.getProperty('sessionScheduler');
    assert.ok(fromContext);
    assert.ok(fromContext instanceof SessionScheduler);
  });

  it('should handle cancel scoped to session', async () => {
    let { agent, session } = await createTestSetup();

    // Verify cancel on non-active session returns null gracefully
    let result = await interactionLoop.cancelInteraction(session.id);
    assert.equal(result, null);
  });

  it('should forward scheduler events for observability', async () => {
    let { agent, session } = await createTestSetup();
    let events = [];

    scheduler.on('schedule', (data) => events.push({ type: 'schedule', ...data }));
    scheduler.on('schedule:skip', (data) => events.push({ type: 'skip', ...data }));

    let frameManager = sessionManager.getFrameManager(session.id);

    // Create a user message commit
    frameManager.merge([{
      id: 'frm_b7e_1', type: 'user-message', content: { text: 'Event test' },
      authorType: 'user', authorID: 'usr_1',
    }], { authorType: 'user', authorID: 'usr_1' });

    await scheduler.onCommit(session.id, frameManager.getLatestCommit());

    assert.ok(events.length > 0, 'Scheduler should emit events');
  });
});
