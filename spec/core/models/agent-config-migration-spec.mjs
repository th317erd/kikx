'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';

// =============================================================================
// Agent Config -> ValueStore Migration Tests
// =============================================================================
// Verifies the B3 migration: Agent config moved from inline JSON column to
// the ValueStore table. All config methods are now async.
// =============================================================================

describe('Agent Config ValueStore Migration', () => {
  let core;
  let models;
  let organization;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Migration Test Org' });
  });

  async function createAgent(name, extras = {}) {
    return models.Agent.create({
      organizationID: organization.id,
      name:           name,
      pluginID:       'mock-agent',
      ...extras,
    });
  }

  // ---------------------------------------------------------------------------
  // Config column removed
  // ---------------------------------------------------------------------------

  it('Agent model no longer has a config column', () => {
    let { Agent } = models;
    let fieldNames = Object.keys(Agent.fields);
    assert.ok(!fieldNames.includes('config'), 'config field should not exist in Agent.fields');
  });

  // ---------------------------------------------------------------------------
  // AGENT_DEFAULTS is empty
  // ---------------------------------------------------------------------------

  it('AGENT_DEFAULTS is empty (no riskLevel)', async () => {
    let agent  = await createAgent('test-migration-defaults');
    let config = await agent.getConfig();
    assert.deepStrictEqual(config, {});
  });

  // ---------------------------------------------------------------------------
  // riskLevel is in PROTECTED_KEYS
  // ---------------------------------------------------------------------------

  it('riskLevel is in PROTECTED_KEYS', () => {
    let { Agent } = models;
    assert.ok(Agent.PROTECTED_KEYS.has('riskLevel'));
  });

  // ---------------------------------------------------------------------------
  // getConfig()
  // ---------------------------------------------------------------------------

  it('getConfig() returns AGENT_DEFAULTS when no entries exist', async () => {
    let agent  = await createAgent('test-migration-get-empty');
    let config = await agent.getConfig();
    assert.deepStrictEqual(config, {});
  });

  it('getConfig() returns stored values merged with defaults', async () => {
    let agent = await createAgent('test-migration-get-stored');
    await agent.setConfig({ model: 'gpt-4', temperature: 0.7 });

    let config = await agent.getConfig();
    assert.equal(config.model, 'gpt-4');
    assert.equal(config.temperature, 0.7);
  });

  // ---------------------------------------------------------------------------
  // updateConfig()
  // ---------------------------------------------------------------------------

  it('updateConfig() stores values in ValueStore', async () => {
    let agent = await createAgent('test-migration-update-store');
    await agent.updateConfig({ model: 'claude-opus' });

    let config = await agent.getConfig();
    assert.equal(config.model, 'claude-opus');

    // Verify directly in ValueStore
    let { ValueStore } = models;
    let entries = await ValueStore
      .where.ownerType.EQ('Agent')
      .ownerID.EQ(agent.id)
      .namespace.EQ('config')
      .all();

    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'model');
    assert.equal(JSON.parse(entries[0].value), 'claude-opus');
  });

  it('updateConfig() upserts existing values', async () => {
    let agent = await createAgent('test-migration-update-upsert');
    await agent.setConfig({ model: 'claude-sonnet' });
    await agent.updateConfig({ model: 'claude-opus' });

    let config = await agent.getConfig();
    assert.equal(config.model, 'claude-opus');

    // Verify only one entry exists
    let { ValueStore } = models;
    let entries = await ValueStore
      .where.ownerType.EQ('Agent')
      .ownerID.EQ(agent.id)
      .namespace.EQ('config')
      .key.EQ('model')
      .all();

    assert.equal(entries.length, 1);
  });

  it('updateConfig() with null value deletes the entry', async () => {
    let agent = await createAgent('test-migration-update-delete');
    await agent.setConfig({ model: 'gpt-4', temperature: 0.7 });
    await agent.updateConfig({ temperature: null });

    let config = await agent.getConfig();
    assert.equal(config.model, 'gpt-4');
    assert.equal(config.temperature, undefined);

    // Verify entry is actually deleted
    let { ValueStore } = models;
    let entries = await ValueStore
      .where.ownerType.EQ('Agent')
      .ownerID.EQ(agent.id)
      .namespace.EQ('config')
      .key.EQ('temperature')
      .all();

    assert.equal(entries.length, 0);
  });

  // ---------------------------------------------------------------------------
  // setConfig()
  // ---------------------------------------------------------------------------

  it('setConfig() replaces all entries', async () => {
    let agent = await createAgent('test-migration-set-replace');
    await agent.setConfig({ model: 'gpt-4', temperature: 0.7 });
    await agent.setConfig({ model: 'claude-opus' });

    let config = await agent.getConfig();
    assert.equal(config.model, 'claude-opus');
    assert.equal(config.temperature, undefined);
  });

  it('setConfig(null) clears all entries', async () => {
    let agent = await createAgent('test-migration-set-null');
    await agent.setConfig({ model: 'gpt-4', temperature: 0.7 });
    await agent.setConfig(null);

    let config = await agent.getConfig();
    assert.deepStrictEqual(config, {});

    // Verify ValueStore is empty
    let { ValueStore } = models;
    let entries = await ValueStore
      .where.ownerType.EQ('Agent')
      .ownerID.EQ(agent.id)
      .namespace.EQ('config')
      .all();

    assert.equal(entries.length, 0);
  });

  // ---------------------------------------------------------------------------
  // Abilities
  // ---------------------------------------------------------------------------

  it('getAbilities() returns null when no abilities set', async () => {
    let agent = await createAgent('test-migration-abilities-null');
    assert.equal(await agent.getAbilities(), null);
  });

  it('setAbilities(text) stores and getAbilities() retrieves', async () => {
    let agent = await createAgent('test-migration-abilities-set');
    await agent.setAbilities('Never auto-merge PRs.');

    assert.equal(await agent.getAbilities(), 'Never auto-merge PRs.');
  });

  it('hasAbilities() returns false when no abilities, true when set', async () => {
    let agent = await createAgent('test-migration-has-abilities');
    assert.equal(await agent.hasAbilities(), false);

    await agent.setAbilities('Check tests before merge.');
    assert.equal(await agent.hasAbilities(), true);
  });

  // ---------------------------------------------------------------------------
  // getSafeConfig()
  // ---------------------------------------------------------------------------

  it('getSafeConfig() strips PROTECTED_KEYS (including riskLevel)', async () => {
    let agent = await createAgent('test-migration-safe');
    await agent.setConfig({
      riskLevel:       'high',
      apiKey:          'sk-secret',
      encryptedAPIKey: '{cipher}',
      model:           'claude-opus',
    });

    let safeConfig = await agent.getSafeConfig();
    assert.equal(safeConfig.riskLevel, undefined);
    assert.equal(safeConfig.apiKey, undefined);
    assert.equal(safeConfig.encryptedAPIKey, undefined);
    assert.equal(safeConfig.model, 'claude-opus');
  });

  // ---------------------------------------------------------------------------
  // Corrupted JSON handling
  // ---------------------------------------------------------------------------

  it('corrupted JSON in ValueStore is handled gracefully', async () => {
    let agent = await createAgent('test-migration-corrupted');

    // Manually insert a ValueStore entry with invalid JSON
    let { ValueStore } = models;
    await ValueStore.create({
      organizationID: organization.id,
      ownerType:      'Agent',
      ownerID:        agent.id,
      namespace:      'config',
      scopeID:        '',
      key:            'brokenField',
      value:          'not valid json {{{',
    });

    // getConfig should still work — the bad value falls back to raw string
    let config = await agent.getConfig();
    assert.equal(config.brokenField, 'not valid json {{{');
  });

  // ---------------------------------------------------------------------------
  // Multiple config keys
  // ---------------------------------------------------------------------------

  it('multiple config keys store independently', async () => {
    let agent = await createAgent('test-migration-multi-keys');
    await agent.setConfig({
      model:       'claude-opus',
      temperature: 0.7,
      maxTokens:   1000,
      tags:        ['production', 'stable'],
    });

    let config = await agent.getConfig();
    assert.equal(config.model, 'claude-opus');
    assert.equal(config.temperature, 0.7);
    assert.equal(config.maxTokens, 1000);
    assert.deepStrictEqual(config.tags, ['production', 'stable']);

    // Verify individual ValueStore entries
    let { ValueStore } = models;
    let entries = await ValueStore
      .where.ownerType.EQ('Agent')
      .ownerID.EQ(agent.id)
      .namespace.EQ('config')
      .all();

    assert.equal(entries.length, 4);

    let keySet = new Set(entries.map((e) => e.key));
    assert.ok(keySet.has('model'));
    assert.ok(keySet.has('temperature'));
    assert.ok(keySet.has('maxTokens'));
    assert.ok(keySet.has('tags'));
  });

  // ---------------------------------------------------------------------------
  // Config methods are async
  // ---------------------------------------------------------------------------

  it('all config methods return promises', async () => {
    let agent = await createAgent('test-migration-async');

    // Verify they return promises
    let getConfigResult    = agent.getConfig();
    let getSafeResult      = agent.getSafeConfig();
    let getAbilitiesResult = agent.getAbilities();
    let hasAbilitiesResult = agent.hasAbilities();
    let setConfigResult    = agent.setConfig({ test: true });
    let updateConfigResult = agent.updateConfig({ more: true });
    let setAbilitiesResult = agent.setAbilities('text');

    assert.ok(getConfigResult instanceof Promise);
    assert.ok(getSafeResult instanceof Promise);
    assert.ok(getAbilitiesResult instanceof Promise);
    assert.ok(hasAbilitiesResult instanceof Promise);
    assert.ok(setConfigResult instanceof Promise);
    assert.ok(updateConfigResult instanceof Promise);
    assert.ok(setAbilitiesResult instanceof Promise);

    // Resolve them all
    await Promise.all([
      getConfigResult, getSafeResult, getAbilitiesResult,
      hasAbilitiesResult, setConfigResult, updateConfigResult,
      setAbilitiesResult,
    ]);
  });

  // ---------------------------------------------------------------------------
  // Cross-agent isolation
  // ---------------------------------------------------------------------------

  it('config entries from different agents do not interfere', async () => {
    let agent1 = await createAgent('test-migration-iso-a');
    let agent2 = await createAgent('test-migration-iso-b');

    await agent1.setConfig({ model: 'gpt-4' });
    await agent2.setConfig({ model: 'claude-opus' });

    let config1 = await agent1.getConfig();
    let config2 = await agent2.getConfig();

    assert.equal(config1.model, 'gpt-4');
    assert.equal(config2.model, 'claude-opus');
  });
});
