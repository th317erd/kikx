'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { SessionManager }  from '../../../src/core/session/index.mjs';

// =============================================================================
// Participant Role Tests
// =============================================================================
// Verifies the `role` field on Participant model: defaults, creation with
// explicit role, updates, and querying by role.
// =============================================================================

describe('Participant role field', () => {
  let core;
  let models;
  let manager;
  let organization;

  before(async () => {
    core   = createKikxCore();
    await core.start();
    models = core.getModels();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    manager      = new SessionManager(core.getContext());
    organization = await models.Organization.create({ name: 'Role Test Org' });
  });

  async function createAgentAndSession(agentName) {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           agentName,
      pluginID:       'mock-agent',
    });

    let session = await manager.createSession(organization.id);
    return { agent, session };
  }

  // ---------------------------------------------------------------------------
  // Default role
  // ---------------------------------------------------------------------------

  it('default role is member when no role specified', async () => {
    let { agent, session } = await createAgentAndSession('test-role-default');
    let participant = await manager.addParticipant(session.id, agent.id);

    assert.equal(participant.role, 'member');
  });

  it('default role persists to database correctly', async () => {
    let { agent, session } = await createAgentAndSession('test-role-persist');
    let participant = await manager.addParticipant(session.id, agent.id);

    // Re-fetch from DB
    let { Participant } = models;
    let fetched = await Participant.where.id.EQ(participant.id).first();
    assert.equal(fetched.role, 'member');
  });

  // ---------------------------------------------------------------------------
  // Explicit role on creation
  // ---------------------------------------------------------------------------

  it('creates participant with coordinator role', async () => {
    let { agent, session } = await createAgentAndSession('test-role-coord');
    let participant = await manager.addParticipant(session.id, agent.id, { role: 'coordinator' });

    assert.equal(participant.role, 'coordinator');
  });

  it('creates participant with member role explicitly', async () => {
    let { agent, session } = await createAgentAndSession('test-role-explicit-member');
    let participant = await manager.addParticipant(session.id, agent.id, { role: 'member' });

    assert.equal(participant.role, 'member');
  });

  // ---------------------------------------------------------------------------
  // Update role
  // ---------------------------------------------------------------------------

  it('updateParticipant changes role from member to coordinator', async () => {
    let { agent, session } = await createAgentAndSession('test-role-update');
    let participant = await manager.addParticipant(session.id, agent.id);
    assert.equal(participant.role, 'member');

    let updated = await manager.updateParticipant(participant.id, { role: 'coordinator' });
    assert.equal(updated.role, 'coordinator');

    // Verify persisted
    let { Participant } = models;
    let fetched = await Participant.where.id.EQ(participant.id).first();
    assert.equal(fetched.role, 'coordinator');
  });

  it('updateParticipant changes role from coordinator to member', async () => {
    let { agent, session } = await createAgentAndSession('test-role-downgrade');
    let participant = await manager.addParticipant(session.id, agent.id, { role: 'coordinator' });
    assert.equal(participant.role, 'coordinator');

    let updated = await manager.updateParticipant(participant.id, { role: 'member' });
    assert.equal(updated.role, 'member');
  });

  it('updateParticipant with no role does not change existing role', async () => {
    let { agent, session } = await createAgentAndSession('test-role-noop');
    let participant = await manager.addParticipant(session.id, agent.id, { role: 'coordinator' });

    let updated = await manager.updateParticipant(participant.id, {});
    assert.equal(updated.role, 'coordinator');
  });

  // ---------------------------------------------------------------------------
  // Query by role — getCoordinators
  // ---------------------------------------------------------------------------

  it('getCoordinators returns only coordinator participants', async () => {
    let { session } = await createAgentAndSession('test-role-query-skip');

    let agent1 = await models.Agent.create({ organizationID: organization.id, name: 'test-coord-a', pluginID: 'mock-agent' });
    let agent2 = await models.Agent.create({ organizationID: organization.id, name: 'test-coord-b', pluginID: 'mock-agent' });
    let agent3 = await models.Agent.create({ organizationID: organization.id, name: 'test-member-c', pluginID: 'mock-agent' });

    await manager.addParticipant(session.id, agent1.id, { role: 'coordinator' });
    await manager.addParticipant(session.id, agent2.id, { role: 'coordinator' });
    await manager.addParticipant(session.id, agent3.id, { role: 'member' });

    let coordinators = await manager.getCoordinators(session.id);
    assert.equal(coordinators.length, 2);

    let coordinatorIDs = coordinators.map((c) => c.agentID).sort();
    assert.deepStrictEqual(coordinatorIDs, [agent1.id, agent2.id].sort());
  });

  it('getCoordinators returns empty array when no coordinators exist', async () => {
    let { agent, session } = await createAgentAndSession('test-role-no-coords');
    await manager.addParticipant(session.id, agent.id); // default member

    let coordinators = await manager.getCoordinators(session.id);
    assert.equal(coordinators.length, 0);
  });

  it('getCoordinators throws when sessionID is missing', async () => {
    await assert.rejects(
      () => manager.getCoordinators(null),
      { message: /sessionID is required/ },
    );
  });

  // ---------------------------------------------------------------------------
  // Role is session-contextual
  // ---------------------------------------------------------------------------

  it('same agent can have different roles in different sessions', async () => {
    let agent   = await models.Agent.create({ organizationID: organization.id, name: 'test-multi-role', pluginID: 'mock-agent' });
    let session1 = await manager.createSession(organization.id);
    let session2 = await manager.createSession(organization.id);

    let p1 = await manager.addParticipant(session1.id, agent.id, { role: 'coordinator' });
    let p2 = await manager.addParticipant(session2.id, agent.id, { role: 'member' });

    assert.equal(p1.role, 'coordinator');
    assert.equal(p2.role, 'member');
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('idempotent addParticipant returns existing participant (does not overwrite role)', async () => {
    let { agent, session } = await createAgentAndSession('test-role-idempotent');
    let p1 = await manager.addParticipant(session.id, agent.id, { role: 'coordinator' });
    let p2 = await manager.addParticipant(session.id, agent.id, { role: 'member' });

    // Should return the existing record, not create a new one
    assert.equal(p1.id, p2.id);
    assert.equal(p2.role, 'coordinator'); // original role preserved
  });

  it('updateParticipant throws when participant not found', async () => {
    await assert.rejects(
      () => manager.updateParticipant('prt_nonexistent', { role: 'coordinator' }),
      { message: /Participant not found/ },
    );
  });
});
