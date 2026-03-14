'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';

// =============================================================================
// Agent Config Persistence Tests (ValueStore-backed)
// =============================================================================
// Verifies the async config methods backed by ValueStore:
//   getConfig(), setConfig(), updateConfig(), getSafeConfig()
// Agent config is stored as individual key-value entries in the ValueStore table.
// =============================================================================

describe('Agent Config Persistence', () => {
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
    organization = await models.Organization.create({ name: 'Config Test Org' });
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
  // PROTECTED_KEYS static
  // ---------------------------------------------------------------------------

  it('Agent.PROTECTED_KEYS is a Set containing apiKey, encryptedAPIKey, and riskLevel', () => {
    let { Agent } = models;
    assert.ok(Agent.PROTECTED_KEYS instanceof Set);
    assert.ok(Agent.PROTECTED_KEYS.has('apiKey'));
    assert.ok(Agent.PROTECTED_KEYS.has('encryptedAPIKey'));
    assert.ok(Agent.PROTECTED_KEYS.has('riskLevel'));
  });

  // ---------------------------------------------------------------------------
  // getConfig()
  // ---------------------------------------------------------------------------

  it('getConfig is a function on agent instances', async () => {
    let agent = await createAgent('test-config-type');
    assert.equal(typeof agent.getConfig, 'function');
  });

  it('getConfig() with no stored entries returns empty defaults', async () => {
    let agent  = await createAgent('test-config-defaults');
    let config = await agent.getConfig();

    assert.equal(typeof config, 'object');
    assert.notEqual(config, null);
    assert.deepStrictEqual(config, {});
  });

  it('getConfig() with stored config returns stored values', async () => {
    let agent = await createAgent('test-config-merge');
    await agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'high');
    assert.equal(config.model, 'claude-sonnet');
  });

  it('getConfig() stored values are returned', async () => {
    let agent = await createAgent('test-config-override');
    await agent.setConfig({ riskLevel: 'low' });

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'low');
  });

  it('returned object contains only stored keys when no defaults', async () => {
    let agent  = await createAgent('test-config-keys');
    let config = await agent.getConfig();
    let keys   = Object.keys(config);

    assert.deepStrictEqual(keys, []);
  });

  // ---------------------------------------------------------------------------
  // setConfig()
  // ---------------------------------------------------------------------------

  it('setConfig(obj) persists and round-trips via getConfig()', async () => {
    let agent = await createAgent('test-config-roundtrip');
    await agent.setConfig({ riskLevel: 'critical', model: 'gpt-4' });

    // Re-fetch from DB
    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    let config  = await fetched.getConfig();

    assert.equal(config.riskLevel, 'critical');
    assert.equal(config.model, 'gpt-4');
  });

  it('setConfig(null) clears config back to defaults', async () => {
    let agent = await createAgent('test-config-clear');
    await agent.setConfig({ riskLevel: 'high', custom: 'value' });
    await agent.setConfig(null);

    let config = await agent.getConfig();
    assert.deepStrictEqual(config, {});
    assert.equal(config.custom, undefined);
  });

  it('setConfig({}) stores empty object, getConfig() returns defaults', async () => {
    let agent = await createAgent('test-config-empty');
    await agent.setConfig({});

    let config = await agent.getConfig();
    assert.deepStrictEqual(config, {});
  });

  // ---------------------------------------------------------------------------
  // updateConfig()
  // ---------------------------------------------------------------------------

  it('updateConfig(partial) merges into existing config', async () => {
    let agent = await createAgent('test-config-update-merge');
    await agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });
    await agent.updateConfig({ apiUrl: 'https://api.example.com' });

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'high');
    assert.equal(config.model, 'claude-sonnet');
    assert.equal(config.apiUrl, 'https://api.example.com');
  });

  it('updateConfig(partial) on empty config creates entries', async () => {
    let agent = await createAgent('test-config-update-null');
    await agent.updateConfig({ model: 'gpt-4' });

    let config = await agent.getConfig();
    assert.equal(config.model, 'gpt-4');
  });

  it('updateConfig({}) is a no-op', async () => {
    let agent = await createAgent('test-config-update-noop');
    await agent.setConfig({ riskLevel: 'high' });
    await agent.updateConfig({});

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'high');
  });

  it('updateConfig allows arbitrary keys (model, apiUrl, abilities blob)', async () => {
    let agent = await createAgent('test-config-arbitrary');
    await agent.updateConfig({
      model:     'claude-opus',
      apiUrl:    'https://api.anthropic.com',
      abilities: { codeReview: true, testing: true },
    });

    let config = await agent.getConfig();
    assert.equal(config.model, 'claude-opus');
    assert.equal(config.apiUrl, 'https://api.anthropic.com');
    assert.deepStrictEqual(config.abilities, { codeReview: true, testing: true });
  });

  it('updateConfig upserts existing values', async () => {
    let agent = await createAgent('test-config-upsert');
    await agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });
    await agent.updateConfig({ riskLevel: 'low' });

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'low');
    assert.equal(config.model, 'claude-sonnet');
  });

  it('updateConfig with null value deletes the entry', async () => {
    let agent = await createAgent('test-config-update-delete');
    await agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });
    await agent.updateConfig({ model: null });

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'high');
    assert.equal(config.model, undefined);
  });

  // ---------------------------------------------------------------------------
  // Mutation isolation
  // ---------------------------------------------------------------------------

  it('returns a fresh object on each call (no shared mutation risk)', async () => {
    let agent   = await createAgent('test-config-fresh');
    let config1 = await agent.getConfig();
    let config2 = await agent.getConfig();

    assert.notStrictEqual(config1, config2, 'each call should return a new object');
    assert.deepStrictEqual(config1, config2, 'contents should be identical');
  });

  it('mutating one config does not affect subsequent calls', async () => {
    let agent = await createAgent('test-config-mutation');
    await agent.setConfig({ riskLevel: 'medium' });

    let config = await agent.getConfig();
    config.riskLevel = 'high';

    let fresh = await agent.getConfig();
    assert.equal(fresh.riskLevel, 'medium', 'mutation should not leak to next call');
  });

  it('mutating getConfig() result does not affect stored config', async () => {
    let agent = await createAgent('test-config-mutation-stored');
    await agent.setConfig({ riskLevel: 'high', items: [1, 2, 3] });

    let config = await agent.getConfig();
    config.riskLevel = 'changed';
    config.items.push(4);

    let fresh = await agent.getConfig();
    assert.equal(fresh.riskLevel, 'high');
    assert.deepStrictEqual(fresh.items, [1, 2, 3]);
  });

  // ---------------------------------------------------------------------------
  // Independence across agents
  // ---------------------------------------------------------------------------

  it('different agents have independent configs', async () => {
    let agent1 = await createAgent('test-config-independent-a');
    let agent2 = await createAgent('test-config-independent-b');

    await agent1.setConfig({ riskLevel: 'high' });
    await agent2.setConfig({ riskLevel: 'low' });

    let { Agent } = models;
    let fetched1 = await Agent.where.id.EQ(agent1.id).first();
    let fetched2 = await Agent.where.id.EQ(agent2.id).first();

    assert.equal((await fetched1.getConfig()).riskLevel, 'high');
    assert.equal((await fetched2.getConfig()).riskLevel, 'low');
  });

  // ---------------------------------------------------------------------------
  // getSafeConfig()
  // ---------------------------------------------------------------------------

  it('getSafeConfig() strips protected keys (apiKey)', async () => {
    let agent = await createAgent('test-config-safe-apikey');
    await agent.setConfig({ riskLevel: 'medium', apiKey: 'sk-secret-12345' });

    let safeConfig = await agent.getSafeConfig();
    assert.equal(safeConfig.riskLevel, undefined);
    assert.equal(safeConfig.apiKey, undefined);
  });

  it('getSafeConfig() strips protected keys (encryptedAPIKey)', async () => {
    let agent = await createAgent('test-config-safe-encrypted');
    await agent.setConfig({ riskLevel: 'high', encryptedAPIKey: '{ciphertext}' });

    let safeConfig = await agent.getSafeConfig();
    assert.equal(safeConfig.riskLevel, undefined);
    assert.equal(safeConfig.encryptedAPIKey, undefined);
  });

  it('getSafeConfig() strips riskLevel (now a protected key)', async () => {
    let agent = await createAgent('test-config-safe-risklevel');
    await agent.setConfig({ riskLevel: 'high', model: 'claude-opus' });

    let safeConfig = await agent.getSafeConfig();
    assert.equal(safeConfig.riskLevel, undefined);
    assert.equal(safeConfig.model, 'claude-opus');
  });

  it('getSafeConfig() returns defaults when no config stored', async () => {
    let agent      = await createAgent('test-config-safe-defaults');
    let safeConfig = await agent.getSafeConfig();

    assert.deepStrictEqual(safeConfig, {});
  });

  it('getSafeConfig() returns fresh copy (mutation isolation)', async () => {
    let agent = await createAgent('test-config-safe-fresh');
    let safe1 = await agent.getSafeConfig();
    let safe2 = await agent.getSafeConfig();

    assert.notStrictEqual(safe1, safe2);
    assert.deepStrictEqual(safe1, safe2);
  });

  // ---------------------------------------------------------------------------
  // Abilities convenience methods
  // ---------------------------------------------------------------------------

  it('getAbilities() returns null when no abilities stored', async () => {
    let agent = await createAgent('test-abilities-null');
    assert.equal(await agent.getAbilities(), null);
  });

  it('getAbilities() returns the abilities string when stored', async () => {
    let agent = await createAgent('test-abilities-get');
    await agent.updateConfig({ abilities: 'If merging to main, ask about production deploy.' });
    assert.equal(await agent.getAbilities(), 'If merging to main, ask about production deploy.');
  });

  it('setAbilities(text) persists abilities string in config', async () => {
    let agent = await createAgent('test-abilities-set');
    await agent.setAbilities('Always respond in Spanish.');

    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    assert.equal(await fetched.getAbilities(), 'Always respond in Spanish.');
  });

  it('setAbilities(null) clears abilities', async () => {
    let agent = await createAgent('test-abilities-clear');
    await agent.setAbilities('Some ability text');
    await agent.setAbilities(null);

    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    assert.equal(await fetched.getAbilities(), null);
  });

  it('getAbilities() round-trips through DB fetch', async () => {
    let agent = await createAgent('test-abilities-roundtrip');
    let text  = 'Rule 1: No deploys on Friday.\nRule 2: Always run tests.';
    await agent.setAbilities(text);

    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    assert.equal(await fetched.getAbilities(), text);
  });

  it('hasAbilities() returns false when no abilities', async () => {
    let agent = await createAgent('test-has-abilities-false');
    assert.equal(await agent.hasAbilities(), false);
  });

  it('hasAbilities() returns true when abilities text is non-empty', async () => {
    let agent = await createAgent('test-has-abilities-true');
    await agent.setAbilities('Check for breaking changes before merge.');
    assert.equal(await agent.hasAbilities(), true);
  });

  it('abilities are independent from other config keys', async () => {
    let agent = await createAgent('test-abilities-independent');
    await agent.setConfig({ riskLevel: 'high', model: 'claude-opus' });
    await agent.setAbilities('Never auto-merge PRs.');

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'high');
    assert.equal(config.model, 'claude-opus');
    assert.equal(config.abilities, 'Never auto-merge PRs.');
    assert.equal(await agent.getAbilities(), 'Never auto-merge PRs.');
  });

  // ---------------------------------------------------------------------------
  // Version bump
  // ---------------------------------------------------------------------------

  it('Agent model version is 3', () => {
    let { Agent } = models;
    assert.equal(Agent.version, 3);
  });

  // ---------------------------------------------------------------------------
  // AGENT_DEFAULTS is empty
  // ---------------------------------------------------------------------------

  it('AGENT_DEFAULTS is empty (no riskLevel)', async () => {
    let agent  = await createAgent('test-empty-defaults');
    let config = await agent.getConfig();
    assert.deepStrictEqual(config, {});
  });
});
