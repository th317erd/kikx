'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createHeroCore,
  DEFAULT_MODELS,
  Organization,
  User,
  Role,
  Agent,
  Session,
  Participant,
  Frame,
} from '../../src/core/index.mjs';

// =============================================================================
// Helper: create a started core with default models
// =============================================================================
async function createStartedCore() {
  let core = createHeroCore();
  await core.start();
  return core;
}

// =============================================================================
// Model Definitions
// =============================================================================
describe('Model definitions', () => {
  it('should export all 7 default models', () => {
    assert.equal(DEFAULT_MODELS.length, 7);
  });

  it('should include all expected model classes', () => {
    let names = DEFAULT_MODELS.map((M) => M.name);
    assert.ok(names.includes('Organization'));
    assert.ok(names.includes('User'));
    assert.ok(names.includes('Role'));
    assert.ok(names.includes('Agent'));
    assert.ok(names.includes('Session'));
    assert.ok(names.includes('Participant'));
    assert.ok(names.includes('Frame'));
  });

  it('should have version on all models', () => {
    for (let M of DEFAULT_MODELS)
      assert.equal(typeof M.version, 'number', `${M.name} should have a numeric version`);
  });

  it('should have fields on all models', () => {
    for (let M of DEFAULT_MODELS)
      assert.ok(M.fields, `${M.name} should have static fields`);
  });
});

// =============================================================================
// Core with default models
// =============================================================================
describe('Core with default models', () => {
  let core;

  beforeEach(async () => {
    core = await createStartedCore();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should register all 7 models', () => {
    let models = core.getModels();
    let names  = Object.keys(models);
    assert.ok(names.includes('Organization'), 'should have Organization');
    assert.ok(names.includes('User'), 'should have User');
    assert.ok(names.includes('Role'), 'should have Role');
    assert.ok(names.includes('Agent'), 'should have Agent');
    assert.ok(names.includes('Session'), 'should have Session');
    assert.ok(names.includes('Participant'), 'should have Participant');
    assert.ok(names.includes('Frame'), 'should have Frame');
  });

  it('should access individual models via getModel()', () => {
    assert.ok(core.getModel('Organization'));
    assert.ok(core.getModel('User'));
    assert.ok(core.getModel('Frame'));
    assert.equal(core.getModel('NonExistent'), null);
  });
});

// =============================================================================
// Organization CRUD
// =============================================================================
describe('Organization model', () => {
  let core;
  let models;

  beforeEach(async () => {
    core   = await createStartedCore();
    models = core.getModels();
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should create an organization', async () => {
    let org = await models.Organization.create({ name: 'Test Org' });
    assert.ok(org.id);
    assert.ok(org.id.startsWith('org_'));
    assert.equal(org.name, 'Test Org');
    assert.ok(org.createdAt);
    assert.ok(org.updatedAt);
  });

  it('should query organizations', async () => {
    await models.Organization.create({ name: 'Alpha' });
    await models.Organization.create({ name: 'Beta' });

    let all = await models.Organization.where.all();
    assert.equal(all.length, 2);
  });

  it('should find by name', async () => {
    await models.Organization.create({ name: 'FindMe' });
    let found = await models.Organization.where.name.EQ('FindMe').first();
    assert.ok(found);
    assert.equal(found.name, 'FindMe');
  });
});

// =============================================================================
// User CRUD
// =============================================================================
describe('User model', () => {
  let core;
  let models;
  let org;

  beforeEach(async () => {
    core   = await createStartedCore();
    models = core.getModels();
    org    = await models.Organization.create({ name: 'Test Org' });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should create a user', async () => {
    let user = await models.User.create({
      organizationID: org.id,
      email:          'test@example.com',
      firstName:      'Test',
      lastName:       'User',
    });

    assert.ok(user.id);
    assert.ok(user.id.startsWith('usr_'));
    assert.equal(user.email, 'test@example.com');
    assert.equal(user.firstName, 'Test');
    assert.equal(user.lastName, 'User');
  });

  it('should lowercase email on save', async () => {
    let user = await models.User.create({
      organizationID: org.id,
      email:          '  TEST@Example.COM  ',
    });

    assert.equal(user.email, 'test@example.com');
  });

  it('should return display name', async () => {
    let user = await models.User.create({
      organizationID: org.id,
      email:          'alice@example.com',
      firstName:      'Alice',
      lastName:       'Smith',
    });

    assert.equal(user.getDisplayName(), 'Alice Smith');
  });

  it('should return email as display name when no name set', async () => {
    let user = await models.User.create({
      organizationID: org.id,
      email:          'noname@example.com',
    });

    assert.equal(user.getDisplayName(), 'noname@example.com');
  });

  it('should store passwordSlot as text', async () => {
    let slotData = JSON.stringify({ ciphertext: 'abc', iv: 'def', authTag: 'ghi', salt: 'jkl' });
    let user = await models.User.create({
      organizationID: org.id,
      email:          'vault@example.com',
      passwordSlot:   slotData,
    });

    let found = await models.User.where.id.EQ(user.id).first();
    assert.equal(found.passwordSlot, slotData);
  });
});

// =============================================================================
// Role CRUD
// =============================================================================
describe('Role model', () => {
  let core;
  let models;
  let org;
  let user;

  beforeEach(async () => {
    core   = await createStartedCore();
    models = core.getModels();
    org    = await models.Organization.create({ name: 'Test Org' });
    user   = await models.User.create({ organizationID: org.id, email: 'alice@test.com' });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should create a role', async () => {
    let role = await models.Role.create({
      organizationID: org.id,
      userID:         user.id,
      name:           'admin',
    });

    assert.ok(role.id);
    assert.ok(role.id.startsWith('rol_'));
    assert.equal(role.name, 'admin');
  });

  it('should query roles by user', async () => {
    await models.Role.create({ organizationID: org.id, userID: user.id, name: 'admin' });
    await models.Role.create({ organizationID: org.id, userID: user.id, name: 'member' });

    let roles = await models.Role.where.userID.EQ(user.id).all();
    assert.equal(roles.length, 2);
  });
});

// =============================================================================
// Agent CRUD
// =============================================================================
describe('Agent model', () => {
  let core;
  let models;
  let org;

  beforeEach(async () => {
    core   = await createStartedCore();
    models = core.getModels();
    org    = await models.Organization.create({ name: 'Test Org' });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should create an agent', async () => {
    let agent = await models.Agent.create({
      organizationID: org.id,
      name:           'test-claude',
      pluginID:       'claude-agent',
    });

    assert.ok(agent.id);
    assert.ok(agent.id.startsWith('agt_'));
    assert.equal(agent.name, 'test-claude');
    assert.equal(agent.pluginID, 'claude-agent');
  });

  it('should store encrypted API key', async () => {
    let encrypted = JSON.stringify({ ciphertext: 'enc', iv: '123', authTag: 'tag' });
    let agent = await models.Agent.create({
      organizationID:  org.id,
      name:            'test-agent',
      pluginID:        'claude-agent',
      encryptedAPIKey: encrypted,
    });

    let found = await models.Agent.where.id.EQ(agent.id).first();
    assert.equal(found.encryptedAPIKey, encrypted);
  });

  it('should store instructions', async () => {
    let agent = await models.Agent.create({
      organizationID: org.id,
      name:           'test-instructed',
      pluginID:       'claude-agent',
      instructions:   'You are a helpful assistant.',
    });

    assert.equal(agent.instructions, 'You are a helpful assistant.');
  });
});

// =============================================================================
// Session CRUD
// =============================================================================
describe('Session model', () => {
  let core;
  let models;
  let org;

  beforeEach(async () => {
    core   = await createStartedCore();
    models = core.getModels();
    org    = await models.Organization.create({ name: 'Test Org' });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should create a session with default name', async () => {
    let session = await models.Session.create({
      organizationID: org.id,
    });

    assert.ok(session.id);
    assert.ok(session.id.startsWith('ses_'));
    assert.equal(session.name, 'New Session');
    assert.equal(session.archived, false);
  });

  it('should create a session with custom name', async () => {
    let session = await models.Session.create({
      organizationID: org.id,
      name:           'Project Discussion',
    });

    assert.equal(session.name, 'Project Discussion');
  });

  it('should archive a session', async () => {
    let session = await models.Session.create({ organizationID: org.id });
    session.archived = true;
    await session.save();

    let found = await models.Session.where.id.EQ(session.id).first();
    assert.equal(found.archived, true);
  });
});

// =============================================================================
// Participant CRUD
// =============================================================================
describe('Participant model', () => {
  let core;
  let models;
  let org;
  let session;
  let agent;

  beforeEach(async () => {
    core    = await createStartedCore();
    models  = core.getModels();
    org     = await models.Organization.create({ name: 'Test Org' });
    agent   = await models.Agent.create({ organizationID: org.id, name: 'test-bot', pluginID: 'claude-agent' });
    session = await models.Session.create({ organizationID: org.id, name: 'Test Chat' });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should create a participant', async () => {
    let participant = await models.Participant.create({
      sessionID: session.id,
      agentID:   agent.id,
    });

    assert.ok(participant.id);
    assert.ok(participant.id.startsWith('prt_'));
  });

  it('should create a participant with alias', async () => {
    let participant = await models.Participant.create({
      sessionID: session.id,
      agentID:   agent.id,
      alias:     'BobTheBurgerGuy',
    });

    assert.equal(participant.alias, 'BobTheBurgerGuy');
    assert.equal(participant.getDisplayName(), 'BobTheBurgerGuy');
  });

  it('should return null displayName when no alias', async () => {
    let participant = await models.Participant.create({
      sessionID: session.id,
      agentID:   agent.id,
    });

    assert.equal(participant.getDisplayName(), null);
  });
});

// =============================================================================
// Frame CRUD
// =============================================================================
describe('Frame model', () => {
  let core;
  let models;
  let org;
  let session;

  beforeEach(async () => {
    core    = await createStartedCore();
    models  = core.getModels();
    org     = await models.Organization.create({ name: 'Test Org' });
    session = await models.Session.create({ organizationID: org.id });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should create a frame', async () => {
    let frame = await models.Frame.create({
      sessionID:     session.id,
      interactionID: 'int_001',
      order:         1,
      type:          'message',
      timestamp:     Date.now(),
    });

    assert.ok(frame.id);
    assert.ok(frame.id.startsWith('frm_'));
    assert.equal(frame.type, 'message');
    assert.equal(frame.hidden, true);  // default
    assert.equal(frame.deleted, false);
    assert.equal(frame.processed, false);
  });

  it('should store and parse JSON content', async () => {
    let contentData = { text: 'Hello world', format: 'html' };
    let frame = await models.Frame.create({
      sessionID:     session.id,
      interactionID: 'int_001',
      order:         1,
      type:          'message',
      content:       JSON.stringify(contentData),
      timestamp:     Date.now(),
    });

    let found = await models.Frame.where.id.EQ(frame.id).first();
    let parsed = found.getContent();
    assert.deepEqual(parsed, contentData);
  });

  it('should store and parse JSON targets', async () => {
    let targetList = [ 'frm_abc', 'frm_def' ];
    let frame = await models.Frame.create({
      sessionID:     session.id,
      interactionID: 'int_001',
      order:         1,
      type:          'prompt-response',
      targets:       JSON.stringify(targetList),
      timestamp:     Date.now(),
    });

    let found = await models.Frame.where.id.EQ(frame.id).first();
    assert.deepEqual(found.getTargets(), targetList);
  });

  it('should return empty array for null targets', async () => {
    let frame = await models.Frame.create({
      sessionID:     session.id,
      interactionID: 'int_001',
      order:         1,
      type:          'message',
      timestamp:     Date.now(),
    });

    assert.deepEqual(frame.getTargets(), []);
  });

  it('should query frames by session and order', async () => {
    await models.Frame.create({ sessionID: session.id, interactionID: 'int_001', order: 1, type: 'message', timestamp: Date.now() });
    await models.Frame.create({ sessionID: session.id, interactionID: 'int_001', order: 2, type: 'message', timestamp: Date.now() });
    await models.Frame.create({ sessionID: session.id, interactionID: 'int_001', order: 3, type: 'tool-call', timestamp: Date.now() });

    let frames = await models.Frame.where.sessionID.EQ(session.id).all();
    assert.equal(frames.length, 3);
  });

  it('should filter frames by type', async () => {
    await models.Frame.create({ sessionID: session.id, interactionID: 'int_001', order: 1, type: 'message', timestamp: Date.now() });
    await models.Frame.create({ sessionID: session.id, interactionID: 'int_001', order: 2, type: 'tool-call', timestamp: Date.now() });
    await models.Frame.create({ sessionID: session.id, interactionID: 'int_001', order: 3, type: 'message', timestamp: Date.now() });

    let messages = await models.Frame.where.type.EQ('message').all();
    assert.equal(messages.length, 2);
  });

  it('should mark frame as processed', async () => {
    let frame = await models.Frame.create({
      sessionID:     session.id,
      interactionID: 'int_001',
      order:         1,
      type:          'tool-call',
      timestamp:     Date.now(),
    });

    frame.processed = true;
    frame.processedAt = new Date().toISOString();
    await frame.save();

    let found = await models.Frame.where.id.EQ(frame.id).first();
    assert.equal(found.processed, true);
    assert.ok(found.processedAt);
  });

  it('should store author info', async () => {
    let frame = await models.Frame.create({
      sessionID:     session.id,
      interactionID: 'int_001',
      order:         1,
      type:          'message',
      authorType:    'agent',
      authorID:      'agt_test123',
      timestamp:     Date.now(),
    });

    assert.equal(frame.authorType, 'agent');
    assert.equal(frame.authorID, 'agt_test123');
  });

  it('should support phantom frame grouping', async () => {
    let frame = await models.Frame.create({
      sessionID:     session.id,
      interactionID: 'int_001',
      order:         1,
      type:          'reflection',
      groupID:       'grp_abc',
      groupType:     'thinking',
      timestamp:     Date.now(),
    });

    assert.equal(frame.groupID, 'grp_abc');
    assert.equal(frame.groupType, 'thinking');
  });
});

// =============================================================================
// Model access from context
// =============================================================================
describe('Models from context', () => {
  let core;

  beforeEach(async () => {
    core = await createStartedCore();
  });

  afterEach(async () => {
    await core.stop();
  });

  it('should access models from context', () => {
    let context = core.getContext();
    let models  = context.getProperty('models');
    assert.ok(models);
    assert.ok(models.Organization);
    assert.ok(models.User);
  });

  it('should access connection from context', () => {
    let context    = core.getContext();
    let connection = context.getProperty('connection');
    assert.ok(connection);
  });

  it('should access models from model instances (getModels)', async () => {
    let models = core.getModels();
    let org    = await models.Organization.create({ name: 'FromInstance' });

    // Model instances should be able to call getModels()
    let instanceModels = org.getModels();
    assert.ok(instanceModels.User);
    assert.ok(instanceModels.Session);
  });

  it('should access specific model from model instance (getModel)', async () => {
    let models = core.getModels();
    let org    = await models.Organization.create({ name: 'SpecificModel' });

    let UserModel = org.getModel('User');
    assert.ok(UserModel);
  });
});
