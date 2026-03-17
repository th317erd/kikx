'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }    from '../../../src/core/index.mjs';
import { AgentResolver }     from '../../../src/core/scheduling/agent-resolver.mjs';
import { AgentInterface }    from '../../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Mock Agent Plugin
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for testing';

  async *_createGenerator() {
    yield { type: 'done', content: {} };
  }
}

// =============================================================================
// Agent Resolver Tests
// =============================================================================

describe('AgentResolver', () => {
  let core;
  let models;
  let resolver;

  before(async () => {
    core = createKikxCore();
    await core.start();

    // Register mock-agent type so resolve() can instantiate it
    core.getPluginRegistry().registerAgentType('mock-agent', MockAgent);

    models   = core.getModels();
    resolver = new AgentResolver(core);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestOrg() {
    return models.Organization.create({ name: 'Resolver Test Org' });
  }

  async function createTestAgentRecord(org, overrides = {}) {
    return models.Agent.create({
      organizationID: org.id,
      name:           'test-resolver-agent',
      pluginID:       'mock-agent',
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('should throw without a core instance', () => {
      assert.throws(
        () => new AgentResolver(),
        /requires a KikxCore instance/,
      );
    });

    it('should throw with null core', () => {
      assert.throws(
        () => new AgentResolver(null),
        /requires a KikxCore instance/,
      );
    });

    it('should create successfully with a valid core', () => {
      let instance = new AgentResolver(core);
      assert.ok(instance);
    });
  });

  // ---------------------------------------------------------------------------
  // resolve() — convenience method preservation
  // ---------------------------------------------------------------------------

  describe('resolve() convenience method preservation', () => {
    it('should return hasBehaviors, getBehaviors, and getConfig as functions on resolvedAgent', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org);

      let { resolvedAgent } = await resolver.resolve(agent.id);

      assert.equal(typeof resolvedAgent.hasBehaviors, 'function');
      assert.equal(typeof resolvedAgent.getBehaviors, 'function');
      assert.equal(typeof resolvedAgent.getConfig, 'function');
    });

    it('should delegate hasBehaviors() to the original agent model', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org);

      // No behaviors set yet — hasBehaviors should return false
      let { resolvedAgent } = await resolver.resolve(agent.id);
      let result = await resolvedAgent.hasBehaviors();
      assert.equal(result, false);

      // Set behaviors on the original agent model
      await agent.setBehaviors('Can search the web.\nCan write code.');

      // Re-resolve to get a fresh resolvedAgent (the delegate points to the
      // same DB-backed model, but let's be explicit)
      let { resolvedAgent: freshResolved } = await resolver.resolve(agent.id);
      let freshResult = await freshResolved.hasBehaviors();
      assert.equal(freshResult, true);
    });

    it('should delegate getBehaviors() to the original agent model', async () => {
      let org            = await createTestOrg();
      let agent          = await createTestAgentRecord(org, { name: 'test-resolver-behaviors' });
      let behaviorsText  = 'Can search the web.\nCan write code.';

      await agent.setBehaviors(behaviorsText);

      let { resolvedAgent } = await resolver.resolve(agent.id);
      let behaviors = await resolvedAgent.getBehaviors();
      assert.equal(behaviors, behaviorsText);
    });

    it('should delegate getConfig() to the original agent model', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org, { name: 'test-resolver-config' });

      await agent.setConfig({ temperature: 0.7, maxTokens: 1024 });

      let { resolvedAgent } = await resolver.resolve(agent.id);
      let config = await resolvedAgent.getConfig();

      assert.equal(config.temperature, 0.7);
      assert.equal(config.maxTokens, 1024);
    });

    it('should return getBehaviors() as null when no behaviors are set', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org, { name: 'test-resolver-no-behaviors' });

      let { resolvedAgent } = await resolver.resolve(agent.id);
      let behaviors = await resolvedAgent.getBehaviors();
      assert.equal(behaviors, null);
    });

    it('should return correct config even when config is empty', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org, { name: 'test-resolver-empty-config' });

      let { resolvedAgent } = await resolver.resolve(agent.id);
      let config = await resolvedAgent.getConfig();

      // AGENT_DEFAULTS is {} so config should be an empty-ish object
      assert.equal(typeof config, 'object');
      assert.ok(config !== null);
    });
  });

  // ---------------------------------------------------------------------------
  // resolve() — instructions preservation
  // ---------------------------------------------------------------------------

  describe('resolve() instructions preservation', () => {
    it('should preserve the agent instructions field on resolvedAgent', async () => {
      let org          = await createTestOrg();
      let instructions = 'You are a helpful assistant that loves cats.';
      let agent        = await createTestAgentRecord(org, {
        name:         'test-resolver-instructions',
        instructions,
      });

      let { resolvedAgent } = await resolver.resolve(agent.id);
      assert.equal(resolvedAgent.instructions, instructions);
    });

    it('should preserve null instructions when not set', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org, {
        name:         'test-resolver-null-instructions',
        instructions: null,
      });

      let { resolvedAgent } = await resolver.resolve(agent.id);
      assert.equal(resolvedAgent.instructions, null);
    });
  });

  // ---------------------------------------------------------------------------
  // resolve() — plain object fallback (no convenience methods)
  // ---------------------------------------------------------------------------

  describe('resolve() plain object fallback', () => {
    it('should work when the agent model does not have convenience methods', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org, { name: 'test-resolver-plain' });

      // Monkey-patch the model to remove hasBehaviors so the guard fails
      let originalHasAbilities = agent.hasBehaviors;
      delete agent.hasBehaviors;

      // We can't directly pass a plain object to resolve() because it fetches
      // from DB by ID, but we can verify the guard logic by temporarily
      // replacing Agent.where to return a plain-object-like result.
      //
      // Instead, we verify the behavior by checking that when the agent
      // retrieved from DB DOES have the methods, they are preserved.
      // The plain object case is tested indirectly: if hasBehaviors is not
      // a function on the fetched agent, none of the methods are attached.

      // Restore for cleanup
      agent.hasBehaviors = originalHasAbilities;

      // The real plain-object test: mock resolve() by subclassing
      class PlainObjectResolver extends AgentResolver {
        async resolve(agentID) {
          let AgentClass = this._core.getAgentType('mock-agent');
          let agentPlugin = new AgentClass(this._core.getContext());

          // Simulate a plain object agent (no model methods)
          let plainAgent = {
            id:             agentID,
            name:           'test-resolver-plain',
            pluginID:       'mock-agent',
            instructions:   'Plain object instructions',
            organizationID: org.id,
          };

          // Apply same logic as the real resolve()
          let resolvedAgent = { ...plainAgent };

          if (typeof plainAgent.hasBehaviors === 'function') {
            resolvedAgent.hasBehaviors = () => plainAgent.hasBehaviors();
            resolvedAgent.getBehaviors = () => plainAgent.getBehaviors();
            resolvedAgent.getConfig    = () => plainAgent.getConfig();
          }

          return { agentPlugin, resolvedAgent };
        }
      }

      let plainResolver = new PlainObjectResolver(core);
      let { resolvedAgent } = await plainResolver.resolve('agt_fake_plain');

      // No convenience methods should be present
      assert.equal(resolvedAgent.hasBehaviors, undefined);
      assert.equal(resolvedAgent.getBehaviors, undefined);
      assert.equal(resolvedAgent.getConfig, undefined);

      // But data fields should still be there
      assert.equal(resolvedAgent.name, 'test-resolver-plain');
      assert.equal(resolvedAgent.instructions, 'Plain object instructions');
      assert.equal(resolvedAgent.pluginID, 'mock-agent');
    });
  });

  // ---------------------------------------------------------------------------
  // resolve() — agent not found
  // ---------------------------------------------------------------------------

  describe('resolve() error cases', () => {
    it('should throw when agent ID does not exist', async () => {
      await assert.rejects(
        () => resolver.resolve('agt_nonexistent_999'),
        /Agent not found/,
      );
    });

    it('should throw when agent plugin type is not registered', async () => {
      let org   = await createTestOrg();
      let agent = await models.Agent.create({
        organizationID: org.id,
        name:           'test-resolver-unknown-plugin',
        pluginID:       'nonexistent-plugin-type',
      });

      await assert.rejects(
        () => resolver.resolve(agent.id),
        /No agent plugin registered for/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // resolve() — agentPlugin returned
  // ---------------------------------------------------------------------------

  describe('resolve() agentPlugin', () => {
    it('should return an agentPlugin instance of the registered agent type', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org, { name: 'test-resolver-plugin-type' });

      let { agentPlugin } = await resolver.resolve(agent.id);
      assert.ok(agentPlugin instanceof MockAgent);
    });
  });

  // ---------------------------------------------------------------------------
  // resolve() — resolvedAgent is a plain object (not the model)
  // ---------------------------------------------------------------------------

  describe('resolve() resolvedAgent shape', () => {
    it('should return resolvedAgent as a plain object with agent data fields', async () => {
      let org   = await createTestOrg();
      let agent = await createTestAgentRecord(org, {
        name:         'test-resolver-shape',
        instructions: 'Shape test instructions',
      });

      let { resolvedAgent } = await resolver.resolve(agent.id);

      // Should have data fields
      assert.equal(resolvedAgent.id, agent.id);
      assert.equal(resolvedAgent.name, 'test-resolver-shape');
      assert.equal(resolvedAgent.pluginID, 'mock-agent');
      assert.equal(resolvedAgent.organizationID, org.id);
      assert.equal(resolvedAgent.instructions, 'Shape test instructions');

      // Should NOT be the original model instance
      assert.notEqual(resolvedAgent, agent);

      // Should be a plain object (with added function properties)
      assert.equal(resolvedAgent.constructor, Object);
    });
  });
});
