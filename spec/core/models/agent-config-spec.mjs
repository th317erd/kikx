'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';

// =============================================================================
// Agent Config Persistence Tests
// =============================================================================
// Verifies the `config` field and associated methods:
//   getConfig(), setConfig(), updateConfig(), getSafeConfig()
// Agent config is persisted as JSON TEXT and merged over defaults.
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
  // Field existence
  // ---------------------------------------------------------------------------

  it('config field exists on agent instances and defaults to null', async () => {
    let agent = await createAgent('test-config-field');
    assert.equal(agent.config == null, true, 'config should be null or undefined by default');
  });

  // ---------------------------------------------------------------------------
  // PROTECTED_KEYS static
  // ---------------------------------------------------------------------------

  it('Agent.PROTECTED_KEYS is a Set containing apiKey and encryptedAPIKey', () => {
    let { Agent } = models;
    assert.ok(Agent.PROTECTED_KEYS instanceof Set);
    assert.ok(Agent.PROTECTED_KEYS.has('apiKey'));
    assert.ok(Agent.PROTECTED_KEYS.has('encryptedAPIKey'));
  });

  // ---------------------------------------------------------------------------
  // getConfig()
  // ---------------------------------------------------------------------------

  it('getConfig is a function on agent instances', async () => {
    let agent = await createAgent('test-config-type');
    assert.equal(typeof agent.getConfig, 'function');
  });

  it('getConfig() with null stored config returns defaults { riskLevel: medium }', async () => {
    let agent  = await createAgent('test-config-defaults');
    let config = agent.getConfig();

    assert.equal(typeof config, 'object');
    assert.notEqual(config, null);
    assert.equal(config.riskLevel, 'medium');
  });

  it('getConfig() with stored config returns stored values merged over defaults', async () => {
    let agent = await createAgent('test-config-merge');
    agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'high');
    assert.equal(config.model, 'claude-sonnet');
  });

  it('getConfig() stored values override defaults', async () => {
    let agent = await createAgent('test-config-override');
    agent.setConfig({ riskLevel: 'low' });
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'low');
  });

  it('getConfig() with invalid JSON in column returns defaults (graceful degradation)', async () => {
    let agent = await createAgent('test-config-invalid-json');

    // Manually set invalid JSON in the column
    agent.config = 'not valid json {{{';

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'medium');
    assert.deepStrictEqual(Object.keys(config), ['riskLevel']);
  });

  it('returned object contains only expected keys when no config stored', async () => {
    let agent  = await createAgent('test-config-keys');
    let config = agent.getConfig();
    let keys   = Object.keys(config);

    assert.deepStrictEqual(keys, ['riskLevel']);
  });

  // ---------------------------------------------------------------------------
  // setConfig()
  // ---------------------------------------------------------------------------

  it('setConfig(obj) + save() persists and round-trips via getConfig()', async () => {
    let agent = await createAgent('test-config-roundtrip');
    agent.setConfig({ riskLevel: 'critical', model: 'gpt-4' });
    await agent.save();

    // Re-fetch from DB
    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    let config  = fetched.getConfig();

    assert.equal(config.riskLevel, 'critical');
    assert.equal(config.model, 'gpt-4');
  });

  it('setConfig(null) clears config back to defaults', async () => {
    let agent = await createAgent('test-config-clear');
    agent.setConfig({ riskLevel: 'high', custom: 'value' });
    await agent.save();

    agent.setConfig(null);
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'medium');
    assert.equal(config.custom, undefined);
  });

  it('setConfig({}) stores empty object, getConfig() returns defaults', async () => {
    let agent = await createAgent('test-config-empty');
    agent.setConfig({});
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'medium');
  });

  // ---------------------------------------------------------------------------
  // updateConfig()
  // ---------------------------------------------------------------------------

  it('updateConfig(partial) shallow-merges into existing config', async () => {
    let agent = await createAgent('test-config-update-merge');
    agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });
    await agent.save();

    agent.updateConfig({ apiUrl: 'https://api.example.com' });
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'high');
    assert.equal(config.model, 'claude-sonnet');
    assert.equal(config.apiUrl, 'https://api.example.com');
  });

  it('updateConfig(partial) on null config creates from partial + defaults', async () => {
    let agent = await createAgent('test-config-update-null');
    agent.updateConfig({ model: 'gpt-4' });
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'medium');
    assert.equal(config.model, 'gpt-4');
  });

  it('updateConfig({}) is a no-op', async () => {
    let agent = await createAgent('test-config-update-noop');
    agent.setConfig({ riskLevel: 'high' });
    await agent.save();

    agent.updateConfig({});
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'high');
  });

  it('updateConfig allows arbitrary keys (model, apiUrl, abilities blob)', async () => {
    let agent = await createAgent('test-config-arbitrary');
    agent.updateConfig({
      model:     'claude-opus',
      apiUrl:    'https://api.anthropic.com',
      abilities: { codeReview: true, testing: true },
    });
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.model, 'claude-opus');
    assert.equal(config.apiUrl, 'https://api.anthropic.com');
    assert.deepStrictEqual(config.abilities, { codeReview: true, testing: true });
  });

  // ---------------------------------------------------------------------------
  // Mutation isolation
  // ---------------------------------------------------------------------------

  it('returns a fresh object on each call (no shared mutation risk)', async () => {
    let agent   = await createAgent('test-config-fresh');
    let config1 = agent.getConfig();
    let config2 = agent.getConfig();

    assert.notStrictEqual(config1, config2, 'each call should return a new object');
    assert.deepStrictEqual(config1, config2, 'contents should be identical');
  });

  it('mutating one config does not affect subsequent calls', async () => {
    let agent  = await createAgent('test-config-mutation');
    let config = agent.getConfig();
    config.riskLevel = 'high';

    let fresh = agent.getConfig();
    assert.equal(fresh.riskLevel, 'medium', 'mutation should not leak to next call');
  });

  it('mutating getConfig() result does not affect stored config', async () => {
    let agent = await createAgent('test-config-mutation-stored');
    agent.setConfig({ riskLevel: 'high', items: [1, 2, 3] });
    await agent.save();

    let config = agent.getConfig();
    config.riskLevel = 'changed';
    config.items.push(4);

    let fresh = agent.getConfig();
    assert.equal(fresh.riskLevel, 'high');
    assert.deepStrictEqual(fresh.items, [1, 2, 3]);
  });

  // ---------------------------------------------------------------------------
  // Independence across agents
  // ---------------------------------------------------------------------------

  it('different agents have independent configs', async () => {
    let agent1 = await createAgent('test-config-independent-a');
    let agent2 = await createAgent('test-config-independent-b');

    agent1.setConfig({ riskLevel: 'high' });
    await agent1.save();

    agent2.setConfig({ riskLevel: 'low' });
    await agent2.save();

    let { Agent } = models;
    let fetched1 = await Agent.where.id.EQ(agent1.id).first();
    let fetched2 = await Agent.where.id.EQ(agent2.id).first();

    assert.equal(fetched1.getConfig().riskLevel, 'high');
    assert.equal(fetched2.getConfig().riskLevel, 'low');
  });

  // ---------------------------------------------------------------------------
  // getSafeConfig()
  // ---------------------------------------------------------------------------

  it('getSafeConfig() strips protected keys (apiKey)', async () => {
    let agent = await createAgent('test-config-safe-apikey');
    // Simulate protected keys in stored config
    agent.config = JSON.stringify({ riskLevel: 'medium', apiKey: 'sk-secret-12345' });

    let safeConfig = agent.getSafeConfig();
    assert.equal(safeConfig.riskLevel, 'medium');
    assert.equal(safeConfig.apiKey, undefined);
  });

  it('getSafeConfig() strips protected keys (encryptedAPIKey)', async () => {
    let agent = await createAgent('test-config-safe-encrypted');
    agent.config = JSON.stringify({ riskLevel: 'high', encryptedAPIKey: '{ciphertext}' });

    let safeConfig = agent.getSafeConfig();
    assert.equal(safeConfig.riskLevel, 'high');
    assert.equal(safeConfig.encryptedAPIKey, undefined);
  });

  it('getSafeConfig() returns defaults when no config stored', async () => {
    let agent      = await createAgent('test-config-safe-defaults');
    let safeConfig = agent.getSafeConfig();

    assert.equal(safeConfig.riskLevel, 'medium');
  });

  it('getSafeConfig() returns fresh copy (mutation isolation)', async () => {
    let agent = await createAgent('test-config-safe-fresh');
    let safe1 = agent.getSafeConfig();
    let safe2 = agent.getSafeConfig();

    assert.notStrictEqual(safe1, safe2);
    assert.deepStrictEqual(safe1, safe2);
  });

  // ---------------------------------------------------------------------------
  // Abilities convenience methods
  // ---------------------------------------------------------------------------

  it('getAbilities() returns null when no abilities stored', async () => {
    let agent = await createAgent('test-abilities-null');
    assert.equal(agent.getAbilities(), null);
  });

  it('getAbilities() returns the abilities string when stored', async () => {
    let agent = await createAgent('test-abilities-get');
    agent.updateConfig({ abilities: 'If merging to main, ask about production deploy.' });
    assert.equal(agent.getAbilities(), 'If merging to main, ask about production deploy.');
  });

  it('setAbilities(text) persists abilities string in config', async () => {
    let agent = await createAgent('test-abilities-set');
    agent.setAbilities('Always respond in Spanish.');
    await agent.save();

    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    assert.equal(fetched.getAbilities(), 'Always respond in Spanish.');
  });

  it('setAbilities(null) clears abilities', async () => {
    let agent = await createAgent('test-abilities-clear');
    agent.setAbilities('Some ability text');
    await agent.save();

    agent.setAbilities(null);
    await agent.save();

    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    assert.equal(fetched.getAbilities(), null);
  });

  it('getAbilities() round-trips through DB fetch', async () => {
    let agent = await createAgent('test-abilities-roundtrip');
    let text  = 'Rule 1: No deploys on Friday.\nRule 2: Always run tests.';
    agent.setAbilities(text);
    await agent.save();

    let { Agent } = models;
    let fetched = await Agent.where.id.EQ(agent.id).first();
    assert.equal(fetched.getAbilities(), text);
  });

  it('hasAbilities() returns false when no abilities', async () => {
    let agent = await createAgent('test-has-abilities-false');
    assert.equal(agent.hasAbilities(), false);
  });

  it('hasAbilities() returns true when abilities text is non-empty', async () => {
    let agent = await createAgent('test-has-abilities-true');
    agent.setAbilities('Check for breaking changes before merge.');
    assert.equal(agent.hasAbilities(), true);
  });

  it('abilities are independent from other config keys', async () => {
    let agent = await createAgent('test-abilities-independent');
    agent.setConfig({ riskLevel: 'high', model: 'claude-opus' });
    await agent.save();

    agent.setAbilities('Never auto-merge PRs.');
    await agent.save();

    let config = agent.getConfig();
    assert.equal(config.riskLevel, 'high');
    assert.equal(config.model, 'claude-opus');
    assert.equal(config.abilities, 'Never auto-merge PRs.');
    assert.equal(agent.getAbilities(), 'Never auto-merge PRs.');
  });

  // ---------------------------------------------------------------------------
  // Version bump
  // ---------------------------------------------------------------------------

  it('Agent model version is 2', () => {
    let { Agent } = models;
    assert.equal(Agent.version, 2);
  });
});
