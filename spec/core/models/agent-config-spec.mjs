'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';

// =============================================================================
// Agent.getConfig() Tests
// =============================================================================
// Verifies the `getConfig()` instance method on the Agent model.
// This is a stub/extension point for future Danger Level support.
// =============================================================================

describe('Agent.getConfig()', () => {
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

  async function createAgent(name) {
    return models.Agent.create({
      organizationID: organization.id,
      name:           name,
      pluginID:       'mock-agent',
    });
  }

  // ---------------------------------------------------------------------------
  // Method existence
  // ---------------------------------------------------------------------------

  it('getConfig is a function on agent instances', async () => {
    let agent = await createAgent('test-config-type');

    assert.equal(typeof agent.getConfig, 'function');
  });

  // ---------------------------------------------------------------------------
  // Return value shape
  // ---------------------------------------------------------------------------

  it('returns an object with riskLevel set to medium', async () => {
    let agent  = await createAgent('test-config-shape');
    let config = agent.getConfig();

    assert.equal(typeof config, 'object');
    assert.notEqual(config, null);
    assert.equal(config.riskLevel, 'medium');
  });

  it('returned object contains only expected keys', async () => {
    let agent  = await createAgent('test-config-keys');
    let config = agent.getConfig();
    let keys   = Object.keys(config);

    assert.deepStrictEqual(keys, ['riskLevel']);
  });

  // ---------------------------------------------------------------------------
  // Fresh object each call (no shared mutation risk)
  // ---------------------------------------------------------------------------

  it('returns a fresh object on each call', async () => {
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

  // ---------------------------------------------------------------------------
  // Consistency across agents
  // ---------------------------------------------------------------------------

  it('different agent instances return equivalent configs', async () => {
    let agent1 = await createAgent('test-config-a');
    let agent2 = await createAgent('test-config-b');

    assert.deepStrictEqual(agent1.getConfig(), agent2.getConfig());
  });
});
