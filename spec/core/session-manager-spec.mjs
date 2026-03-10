'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../src/core/index.mjs';
import { SessionManager } from '../../src/core/session/index.mjs';
import { FrameManager }   from '../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// SessionManager Tests
// =============================================================================
// A single KikxCore instance for the entire suite (created once in `before`).
// Each test creates its own org/session/agent to avoid cross-test interference.
// This avoids the --test-force-exit race that occurs when creating many
// KikxCore instances in rapid succession.
// =============================================================================

describe('SessionManager', () => {
  let core;
  let models;
  let manager;
  let org;

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
    manager = new SessionManager(core.getContext());
    org     = await models.Organization.create({ name: 'Test Org' });
  });

  // ===========================================================================
  // Construction
  // ===========================================================================
  it('should create with a valid context', () => {
    assert.ok(manager);
  });

  it('should throw without a context', () => {
    assert.throws(() => new SessionManager(), {
      message: /requires a CascadingContext/,
    });
  });

  it('should throw with null context', () => {
    assert.throws(() => new SessionManager(null), {
      message: /requires a CascadingContext/,
    });
  });

  it('should throw when context has no models', () => {
    let bareContext = { getProperty: () => null };
    assert.throws(() => new SessionManager(bareContext), {
      message: /requires models/,
    });
  });

  // ===========================================================================
  // createSession
  // ===========================================================================
  it('createSession — should create with default name', async () => {
    let session = await manager.createSession(org.id);
    assert.ok(session);
    assert.ok(session.id);
    assert.ok(session.id.startsWith('ses_'));
    assert.equal(session.name, 'New Session');
    assert.equal(session.archived, false);
    assert.equal(session.organizationID, org.id);
  });

  it('createSession — should create with custom name', async () => {
    let session = await manager.createSession(org.id, { name: 'My Chat' });
    assert.equal(session.name, 'My Chat');
  });

  it('createSession — should create with archived flag', async () => {
    let session = await manager.createSession(org.id, { archived: true });
    assert.equal(session.archived, true);
  });

  it('createSession — should throw without organizationID', async () => {
    await assert.rejects(() => manager.createSession(), {
      message: /organizationID is required/,
    });
  });

  // ===========================================================================
  // getSession
  // ===========================================================================
  it('getSession — should find by ID', async () => {
    let created = await manager.createSession(org.id, { name: 'Findable' });
    let found   = await manager.getSession(created.id);
    assert.ok(found);
    assert.equal(found.id, created.id);
    assert.equal(found.name, 'Findable');
  });

  it('getSession — should return null for non-existent ID', async () => {
    let found = await manager.getSession('ses_nonexistent');
    assert.equal(found, null);
  });

  it('getSession — should return null for null ID', async () => {
    let found = await manager.getSession(null);
    assert.equal(found, null);
  });

  // ===========================================================================
  // getSessions
  // ===========================================================================
  it('getSessions — should list sessions for an org', async () => {
    let freshOrg = await models.Organization.create({ name: 'ListSessions Org' });
    await manager.createSession(freshOrg.id, { name: 'Session A' });
    await manager.createSession(freshOrg.id, { name: 'Session B' });

    let sessions = await manager.getSessions(freshOrg.id);
    assert.equal(sessions.length, 2);
  });

  it('getSessions — should exclude archived by default', async () => {
    let freshOrg = await models.Organization.create({ name: 'ExclArchive Org' });
    await manager.createSession(freshOrg.id, { name: 'Active' });
    await manager.createSession(freshOrg.id, { name: 'Old', archived: true });

    let sessions = await manager.getSessions(freshOrg.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, 'Active');
  });

  it('getSessions — should include archived when flag set', async () => {
    let freshOrg = await models.Organization.create({ name: 'InclArchive Org' });
    await manager.createSession(freshOrg.id, { name: 'Active' });
    await manager.createSession(freshOrg.id, { name: 'Old', archived: true });

    let sessions = await manager.getSessions(freshOrg.id, { includeArchived: true });
    assert.equal(sessions.length, 2);
  });

  it('getSessions — should throw without organizationID', async () => {
    await assert.rejects(() => manager.getSessions(), {
      message: /organizationID is required/,
    });
  });

  // ===========================================================================
  // updateSession
  // ===========================================================================
  it('updateSession — should update name', async () => {
    let session = await manager.createSession(org.id, { name: 'Original' });
    let updated = await manager.updateSession(session.id, { name: 'Renamed' });
    assert.equal(updated.name, 'Renamed');

    let found = await manager.getSession(session.id);
    assert.equal(found.name, 'Renamed');
  });

  it('updateSession — should throw for non-existent session', async () => {
    await assert.rejects(() => manager.updateSession('ses_nope', { name: 'X' }), {
      message: /Session not found/,
    });
  });

  it('updateSession — should throw without sessionID', async () => {
    await assert.rejects(() => manager.updateSession(null, { name: 'X' }), {
      message: /sessionID is required/,
    });
  });

  // ===========================================================================
  // deleteSession
  // ===========================================================================
  it('deleteSession — should delete a session', async () => {
    let session = await manager.createSession(org.id, { name: 'Doomed' });
    let result  = await manager.deleteSession(session.id);
    assert.equal(result, true);

    let found = await manager.getSession(session.id);
    assert.equal(found, null);
  });

  it('deleteSession — should throw for non-existent session', async () => {
    await assert.rejects(() => manager.deleteSession('ses_gone'), {
      message: /Session not found/,
    });
  });

  it('deleteSession — should clean up cached FrameManager', async () => {
    let session      = await manager.createSession(org.id);
    let frameManager = manager.getFrameManager(session.id);
    assert.ok(frameManager);

    await manager.deleteSession(session.id);

    let found = await manager.getSession(session.id);
    assert.equal(found, null);
  });

  // ===========================================================================
  // archiveSession / reviveSession
  // ===========================================================================
  it('archiveSession — should set archived to true', async () => {
    let session  = await manager.createSession(org.id);
    let archived = await manager.archiveSession(session.id);
    assert.equal(archived.archived, true);

    let found = await manager.getSession(session.id);
    assert.equal(found.archived, true);
  });

  it('reviveSession — should set archived to false', async () => {
    let session = await manager.createSession(org.id, { archived: true });
    let revived = await manager.reviveSession(session.id);
    assert.equal(revived.archived, false);

    let found = await manager.getSession(session.id);
    assert.equal(found.archived, false);
  });

  // ===========================================================================
  // addParticipant
  // ===========================================================================
  it('addParticipant — should add to a session', async () => {
    let agent   = await models.Agent.create({ organizationID: org.id, name: 'test-bot', pluginID: 'claude-agent' });
    let session = await manager.createSession(org.id);

    let participant = await manager.addParticipant(session.id, agent.id);
    assert.ok(participant);
    assert.ok(participant.id.startsWith('prt_'));
    assert.equal(participant.sessionID, session.id);
    assert.equal(participant.agentID, agent.id);
  });

  it('addParticipant — should throw for non-existent session', async () => {
    let agent = await models.Agent.create({ organizationID: org.id, name: 'test-nosess', pluginID: 'claude-agent' });

    await assert.rejects(() => manager.addParticipant('ses_nope', agent.id), {
      message: /Session not found/,
    });
  });

  it('addParticipant — should throw for non-existent agent', async () => {
    let session = await manager.createSession(org.id);

    await assert.rejects(() => manager.addParticipant(session.id, 'agt_nope'), {
      message: /Agent not found/,
    });
  });

  it('addParticipant — should throw without sessionID', async () => {
    await assert.rejects(() => manager.addParticipant(null, 'agt_any'), {
      message: /sessionID is required/,
    });
  });

  it('addParticipant — should throw without agentID', async () => {
    let session = await manager.createSession(org.id);

    await assert.rejects(() => manager.addParticipant(session.id, null), {
      message: /agentID is required/,
    });
  });

  // ===========================================================================
  // removeParticipant
  // ===========================================================================
  it('removeParticipant — should remove a participant', async () => {
    let agent   = await models.Agent.create({ organizationID: org.id, name: 'test-rem', pluginID: 'claude-agent' });
    let session = await manager.createSession(org.id);
    await manager.addParticipant(session.id, agent.id);

    let result = await manager.removeParticipant(session.id, agent.id);
    assert.equal(result, true);

    let participants = await manager.getParticipants(session.id);
    assert.equal(participants.length, 0);
  });

  it('removeParticipant — should return null for non-existent', async () => {
    let result = await manager.removeParticipant('ses_nope', 'agt_nope');
    assert.equal(result, null);
  });

  // ===========================================================================
  // getParticipants
  // ===========================================================================
  it('getParticipants — should list for a session', async () => {
    let agentA  = await models.Agent.create({ organizationID: org.id, name: 'test-listA', pluginID: 'claude-agent' });
    let agentB  = await models.Agent.create({ organizationID: org.id, name: 'test-listB', pluginID: 'claude-agent' });
    let session = await manager.createSession(org.id);

    await manager.addParticipant(session.id, agentA.id);
    await manager.addParticipant(session.id, agentB.id);

    let participants = await manager.getParticipants(session.id);
    assert.equal(participants.length, 2);
  });

  it('getParticipants — should return empty for no participants', async () => {
    let session      = await manager.createSession(org.id);
    let participants = await manager.getParticipants(session.id);
    assert.equal(participants.length, 0);
  });

  // ===========================================================================
  // updateParticipant
  // ===========================================================================
  it('updateParticipant — should throw for non-existent', async () => {
    await assert.rejects(() => manager.updateParticipant('prt_nope'), {
      message: /Participant not found/,
    });
  });

  // ===========================================================================
  // getFrameManager
  // ===========================================================================
  it('getFrameManager — should return a FrameManager instance', async () => {
    let session      = await manager.createSession(org.id);
    let frameManager = manager.getFrameManager(session.id);
    assert.ok(frameManager);
    assert.ok(frameManager instanceof FrameManager);
  });

  it('getFrameManager — should enable history by default', async () => {
    let session      = await manager.createSession(org.id);
    let frameManager = manager.getFrameManager(session.id);
    assert.equal(frameManager.history, true);
  });

  it('getFrameManager — should cache by sessionID', async () => {
    let session = await manager.createSession(org.id);
    let first   = manager.getFrameManager(session.id);
    let second  = manager.getFrameManager(session.id);
    assert.strictEqual(first, second);
  });

  it('getFrameManager — should return different instances for different sessions', async () => {
    let session1 = await manager.createSession(org.id);
    let session2 = await manager.createSession(org.id, { name: 'Other' });
    let fm1      = manager.getFrameManager(session1.id);
    let fm2      = manager.getFrameManager(session2.id);
    assert.notEqual(fm1, fm2);
  });

  it('getFrameManager — should throw without sessionID', () => {
    assert.throws(() => manager.getFrameManager(null), {
      message: /sessionID is required/,
    });
  });

  // ===========================================================================
  // destroyFrameManager
  // ===========================================================================
  it('destroyFrameManager — should remove cached FrameManager', async () => {
    let session = await manager.createSession(org.id);
    let first   = manager.getFrameManager(session.id);
    assert.ok(first);

    let existed = manager.destroyFrameManager(session.id);
    assert.equal(existed, true);

    let second = manager.getFrameManager(session.id);
    assert.notEqual(first, second);
  });

  it('destroyFrameManager — should return false for non-cached', () => {
    let existed = manager.destroyFrameManager('ses_nocache');
    assert.equal(existed, false);
  });

  it('destroyFrameManager — should throw without sessionID', () => {
    assert.throws(() => manager.destroyFrameManager(null), {
      message: /sessionID is required/,
    });
  });
});
