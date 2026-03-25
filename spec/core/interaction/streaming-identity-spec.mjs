'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../../src/core/index.mjs';
import { InteractionLoop }    from '../../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../../src/core/session/index.mjs';
import { FramePersistence }   from '../../../src/core/frames/index.mjs';
import { AgentInterface }     from '../../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Streaming Identity Tests
// =============================================================================
// Verifies that interaction:start, delta, and interaction:end events carry
// agent identity fields (agentID, authorType, authorID).
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for streaming identity tests';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks = blocks || [];
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks)
      yield block;

    yield { type: 'Done', content: {} };
  }
}

describe('Streaming identity in InteractionLoop events', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;
  let organization;
  let agent;
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
    organization    = await models.Organization.create({ name: 'Stream ID Org' });
    agent           = await models.Agent.create({ organizationID: organization.id, name: 'test-stream-agent', pluginID: 'mock-agent' });
    session         = await sessionManager.createSession(organization.id);
  });

  // ---------------------------------------------------------------------------
  // interaction:start carries agentID
  // ---------------------------------------------------------------------------

  it('interaction:start event includes agentID', async () => {
    let captured = null;

    interactionLoop.on('interaction:start', (event) => {
      captured = event;
    });

    let mockAgent = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>hello</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'test message',
    });

    assert.ok(captured, 'interaction:start event should have been emitted');
    assert.equal(captured.sessionID, session.id);
    assert.ok(captured.interactionID);
    assert.equal(captured.agentID, agent.id);
  });

  it('interaction:start agentID is null when no agent provided', async () => {
    let captured = null;

    interactionLoop.on('interaction:start', (event) => {
      captured = event;
    });

    let mockAgent = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>hello</p>' }, authorType: 'agent', authorID: null },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      userMessage: 'test message',
    });

    assert.ok(captured);
    assert.equal(captured.agentID, null);
  });

  // ---------------------------------------------------------------------------
  // delta events carry authorType and authorID
  // ---------------------------------------------------------------------------

  it('delta event carries authorType and authorID', async () => {
    let deltas = [];

    interactionLoop.on('Delta', (event) => {
      deltas.push(event);
    });

    let mockAgent = new MockAgent(context, [
      { type: 'Delta', content: { text: 'hello' }, authorType: 'agent', authorID: agent.id },
      { type: 'Message', content: { html: '<p>hello</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'test delta',
    });

    assert.ok(deltas.length > 0, 'at least one delta should have been emitted');

    let delta = deltas[0];
    assert.equal(delta.authorType, 'agent');
    assert.equal(delta.authorID, agent.id);
    assert.equal(delta.sessionID, session.id);
    assert.ok(delta.interactionID);
  });

  it('delta event authorType/authorID default to undefined when not set', async () => {
    let deltas = [];

    interactionLoop.on('Delta', (event) => {
      deltas.push(event);
    });

    let mockAgent = new MockAgent(context, [
      { type: 'Delta', content: { text: 'bare' } },
      { type: 'Message', content: { html: '<p>bare</p>' } },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'test bare delta',
    });

    assert.ok(deltas.length > 0);
    // authorType/authorID should be present (even if undefined)
    assert.ok('authorType' in deltas[0]);
    assert.ok('authorID' in deltas[0]);
  });

  // ---------------------------------------------------------------------------
  // interaction:end carries agentID
  // ---------------------------------------------------------------------------

  it('interaction:end event includes agentID', async () => {
    let captured = null;

    interactionLoop.on('interaction:end', (event) => {
      captured = event;
    });

    let mockAgent = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>done</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'test end',
    });

    assert.ok(captured, 'interaction:end event should have been emitted');
    assert.equal(captured.sessionID, session.id);
    assert.ok(captured.interactionID);
    assert.equal(captured.agentID, agent.id);
  });

  it('interaction:end agentID is null when no agent provided', async () => {
    let captured = null;

    interactionLoop.on('interaction:end', (event) => {
      captured = event;
    });

    let mockAgent = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>done</p>' } },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      userMessage: 'test end no agent',
    });

    assert.ok(captured);
    assert.equal(captured.agentID, null);
  });

  // ---------------------------------------------------------------------------
  // reflection-delta carries identity
  // ---------------------------------------------------------------------------

  it('reflection-delta event carries authorType and authorID', async () => {
    let reflections = [];

    interactionLoop.on('ReflectionDelta', (event) => {
      reflections.push(event);
    });

    let mockAgent = new MockAgent(context, [
      { type: 'ReflectionDelta', content: { text: 'thinking...' }, authorType: 'agent', authorID: agent.id },
      { type: 'Message', content: { html: '<p>result</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent:       { id: agent.id, name: agent.name },
      userMessage: 'test reflection',
    });

    assert.ok(reflections.length > 0);
    assert.equal(reflections[0].authorType, 'agent');
    assert.equal(reflections[0].authorID, agent.id);
  });
});
