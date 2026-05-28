'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }      from '../../src/core/index.mjs';
import { InteractionLoop }     from '../../src/core/interaction/index.mjs';
import { SessionManager }      from '../../src/core/session/index.mjs';
import { FramePersistence }    from '../../src/core/frames/index.mjs';
import { ContentSanitizer }    from '../../src/core/lib/content-sanitizer.mjs';
import { SessionScheduler }    from '../../src/core/scheduling/session-scheduler.mjs';

// =============================================================================
// Phase B8 — Stop/Interrupt as Commit
// =============================================================================

describe('Stop as Commit (B8)', () => {
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
    let org     = await models.Organization.create({ name: 'B8 Org' });
    let agent   = await models.Agent.create({ organizationID: org.id, name: 'test-b8-agent', pluginID: 'mock' });
    let session = await sessionManager.createSession(org.id, { name: 'B8 Test' });

    await sessionManager.addParticipant(session.id, agent.id);

    return { org, agent, session };
  }

  // ---------------------------------------------------------------------------
  // cancelInteraction creates a stop frame
  // ---------------------------------------------------------------------------

  it('should create a stop frame on cancelInteraction', async () => {
    let { agent, session } = await createTestSetup();
    let frameManager = sessionManager.getFrameManager(session.id);

    // Mock an active interaction with a trivial generator
    async function* mockGen() { /* empty */ }

    interactionLoop._active.set(session.id, {
      generator:     mockGen(),
      interactionID: 'int_test_cancel',
      params:        {},
      frameManager,
    });

    await interactionLoop.cancelInteraction(session.id, {
      authorType: 'user',
      authorID:   'usr_1',
    });

    let allFrames = frameManager.toArray();
    let stopFrame = allFrames.find((f) => f.type === 'Stop');

    assert.ok(stopFrame, 'Should have a stop frame');
    assert.equal(stopFrame.content.targetAgentID, null, 'targetAgentID should be null for blanket cancel');
    assert.equal(stopFrame.authorType, 'user');
    assert.ok(!interactionLoop._active.has(session.id), 'Active should be cleaned up');
  });

  it('should create a stop frame with targetAgentID when specified', async () => {
    let { agent, session } = await createTestSetup();
    let frameManager = sessionManager.getFrameManager(session.id);

    async function* mockGen() { /* empty */ }

    // Use composite key — cancelInteraction computes ${sessionID}:${targetAgentID}
    let activeKey = `${session.id}:${agent.id}`;
    interactionLoop._active.set(activeKey, {
      generator:     mockGen(),
      interactionID: 'int_test_target',
      params:        {},
      frameManager,
    });

    await interactionLoop.cancelInteraction(session.id, {
      targetAgentID: agent.id,
      authorType:    'user',
      authorID:      'usr_1',
    });

    let allFrames = frameManager.toArray();
    let stopFrame = allFrames.find((f) => f.type === 'Stop');

    assert.ok(stopFrame, 'Should have a stop frame');
    assert.equal(stopFrame.content.targetAgentID, agent.id, 'targetAgentID should match agent');
  });

  it('should produce a stop commit in the commit log', async () => {
    let { agent, session } = await createTestSetup();
    let frameManager = sessionManager.getFrameManager(session.id);

    async function* mockGen() { /* empty */ }

    interactionLoop._active.set(session.id, {
      generator:     mockGen(),
      interactionID: 'int_test_commit',
      params:        {},
      frameManager,
    });

    let commitsBefore = frameManager.getCommits().length;

    await interactionLoop.cancelInteraction(session.id, {
      authorType: 'user',
      authorID:   'usr_1',
    });

    let commitsAfter = frameManager.getCommits().length;
    assert.ok(commitsAfter > commitsBefore, 'Should create a new commit');

    let latestCommit = frameManager.getLatestCommit();
    assert.equal(latestCommit.authorType, 'user');

    // Commit changes are { frameID, operation } records — resolve the frame
    let stopChangeEntry = latestCommit.changes.find((c) => {
      let frame = frameManager.getHead(c.frameID);
      return frame && frame.type === 'Stop';
    });

    assert.ok(stopChangeEntry, 'Commit should reference a stop frame');
  });

  // ---------------------------------------------------------------------------
  // Stop frame excluded from message assembly
  // ---------------------------------------------------------------------------

  it('should exclude stop frames from message assembly', () => {
    let frames = [
      { id: 'f1', type: 'UserMessage', content: { text: 'Hello' }, hidden: false, deleted: false },
      { id: 'f2', type: 'Stop', content: { targetAgentID: null }, hidden: false, deleted: false },
      { id: 'f3', type: 'Message', content: { html: '<p>Reply</p>' }, hidden: false, deleted: false, authorType: 'agent', authorID: 'agt_1' },
    ];

    let messages = interactionLoop._buildMessages(frames);

    assert.equal(messages.length, 2, 'Stop frame should be excluded');
    assert.ok(!messages.find((m) => m.frameID === 'f2'), 'No message should come from stop frame');
  });

  // ---------------------------------------------------------------------------
  // Scheduler handles stop commits
  // ---------------------------------------------------------------------------

  it('should handle stop commit by cancelling targeted agent in scheduler', async () => {
    let { agent, session } = await createTestSetup();
    let frameManager = sessionManager.getFrameManager(session.id);

    // Seed a stop frame in the FrameManager so the scheduler can resolve it
    let stopFrameID = `frm_stop_test_1_${Date.now()}`;
    frameManager.merge([{
      id:         stopFrameID,
      type: 'Stop',
      content:    { targetAgentID: agent.id },
      authorType: 'user',
      authorID:   'usr_1',
    }], { authorType: 'user', authorID: 'usr_1' });

    let events = [];
    let cancelHandler = (data) => events.push(data);
    scheduler.on('schedule:cancel', cancelHandler);

    // Manually mark agent as active
    scheduler._activeAgents.set(`${session.id}:${agent.id}`, true);
    assert.ok(scheduler.isAgentActive(session.id, agent.id));

    // Use the actual latest commit (which contains the stop frame)
    let stopCommit = frameManager.getLatestCommit();

    let scheduled = await scheduler.onCommit(session.id, stopCommit);

    assert.equal(scheduled.length, 0, 'Stop commit should not schedule new agents');
    assert.ok(!scheduler.isAgentActive(session.id, agent.id), 'Agent should no longer be active');
    assert.equal(events.length, 1, 'Should emit schedule:cancel event');
    assert.equal(events[0].agentID, agent.id);

    scheduler.off('schedule:cancel', cancelHandler);
  });

  it('should cancel ALL active agents on stop commit without targetAgentID', async () => {
    let org     = await models.Organization.create({ name: 'B8 Multi Org' });
    let agentA  = await models.Agent.create({ organizationID: org.id, name: 'test-b8-a', pluginID: 'mock' });
    let agentB  = await models.Agent.create({ organizationID: org.id, name: 'test-b8-b', pluginID: 'mock' });
    let session = await sessionManager.createSession(org.id, { name: 'B8 Multi Cancel' });

    await sessionManager.addParticipant(session.id, agentA.id);
    await sessionManager.addParticipant(session.id, agentB.id);

    let frameManager = sessionManager.getFrameManager(session.id);

    // Seed a stop frame (no targetAgentID → cancel all)
    let stopFrameID = `frm_stop_all_${Date.now()}`;
    frameManager.merge([{
      id:         stopFrameID,
      type: 'Stop',
      content:    { targetAgentID: null },
      authorType: 'user',
      authorID:   'usr_1',
    }], { authorType: 'user', authorID: 'usr_1' });

    // Mark both agents as active
    scheduler._activeAgents.set(`${session.id}:${agentA.id}`, true);
    scheduler._activeAgents.set(`${session.id}:${agentB.id}`, true);

    let events = [];
    let cancelHandler = (data) => events.push(data);
    scheduler.on('schedule:cancel', cancelHandler);

    let stopCommit = frameManager.getLatestCommit();
    await scheduler.onCommit(session.id, stopCommit);

    assert.ok(!scheduler.isAgentActive(session.id, agentA.id), 'Agent A should be cancelled');
    assert.ok(!scheduler.isAgentActive(session.id, agentB.id), 'Agent B should be cancelled');
    assert.equal(events.length, 2, 'Should emit cancel for both agents');

    scheduler.off('schedule:cancel', cancelHandler);
  });

  it('should not error when stopping an agent that is not active', async () => {
    let { agent, session } = await createTestSetup();
    let frameManager = sessionManager.getFrameManager(session.id);

    let stopFrameID = `frm_stop_noop_${Date.now()}`;
    frameManager.merge([{
      id:         stopFrameID,
      type: 'Stop',
      content:    { targetAgentID: agent.id },
      authorType: 'user',
      authorID:   'usr_1',
    }], { authorType: 'user', authorID: 'usr_1' });

    let stopCommit = frameManager.getLatestCommit();
    let scheduled  = await scheduler.onCommit(session.id, stopCommit);
    assert.equal(scheduled.length, 0);
  });
});
