'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { PluginInterface }  from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }   from '../../../src/core/plugin-loader/registry.mjs';
import { setup }            from '../../../src/core/internal-plugins/memory/index.mjs';

// =============================================================================
// Memory Plugin — ValueStore-backed Memory Tools Tests
// =============================================================================
// Tests for memory:getValue, memory:setValue, memory:searchValues
// =============================================================================

describe('Memory Plugin — ValueStore Memory Tools', () => {
  let core;
  let models;
  let context;
  let registry;
  let organization;

  let GetMemoryValueTool;
  let SetMemoryValueTool;
  let SearchMemoryValuesTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    registry = new PluginRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });
    setup((cb) => cb({ registry, context }));

    GetMemoryValueTool     = registry.getTool('memory:getValue');
    SetMemoryValueTool     = registry.getTool('memory:setValue');
    SearchMemoryValuesTool = registry.getTool('memory:searchValues');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Memory Tools Test Org' });
  });

  async function createAgent(name, extras = {}) {
    return models.Agent.create({
      organizationID: organization.id,
      name:           name,
      pluginID:       'mock-agent',
      ...extras,
    });
  }

  function instantiateTool(ToolClass) {
    return new ToolClass({
      getProperty: (key) => context.getProperty(key),
    });
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('setup()', () => {
    it('registers all 3 memory value tools', () => {
      assert.ok(GetMemoryValueTool, 'memory:getValue should be registered');
      assert.ok(SetMemoryValueTool, 'memory:setValue should be registered');
      assert.ok(SearchMemoryValuesTool, 'memory:searchValues should be registered');
    });

    it('all tools extend PluginInterface', () => {
      assert.ok(GetMemoryValueTool.prototype instanceof PluginInterface);
      assert.ok(SetMemoryValueTool.prototype instanceof PluginInterface);
      assert.ok(SearchMemoryValuesTool.prototype instanceof PluginInterface);
    });

    it('all tools define inputSchema', () => {
      assert.ok(GetMemoryValueTool.inputSchema);
      assert.ok(SetMemoryValueTool.inputSchema);
      assert.ok(SearchMemoryValuesTool.inputSchema);
    });

    it('all tools have riskLevel low', () => {
      assert.equal(GetMemoryValueTool.riskLevel, 'low');
      assert.equal(SetMemoryValueTool.riskLevel, 'low');
      assert.equal(SearchMemoryValuesTool.riskLevel, 'low');
    });
  });

  // ---------------------------------------------------------------------------
  // memory:getValue
  // ---------------------------------------------------------------------------

  describe('memory:getValue', () => {
    it('returns null for non-existent key', async () => {
      let agent  = await createAgent('test-get-nonexistent');
      let tool   = instantiateTool(GetMemoryValueTool);
      let result = await tool.execute({ agentID: agent.id, key: 'does-not-exist' });

      assert.equal(result.value, null);
      assert.equal(result.key, 'does-not-exist');
    });

    it('returns stored value after setValue', async () => {
      let agent   = await createAgent('test-get-after-set');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'greeting', value: 'hello world', scopeID: '' });
      let result = await getTool.execute({ agentID: agent.id, key: 'greeting', scopeID: '' });

      assert.equal(result.value, 'hello world');
      assert.equal(result.key, 'greeting');
    });

    it('defaults scopeID to session ID', async () => {
      let agent   = await createAgent('test-get-scope-default');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      let sessionID = 'ses_test_scope_default';

      // Store with explicit scopeID matching session
      await setTool.execute({ agentID: agent.id, key: 'scoped', value: 42, scopeID: sessionID });

      // Retrieve without explicit scopeID but with currentSessionID
      let result = await getTool.execute({
        agentID:          agent.id,
        key:              'scoped',
        currentSessionID: sessionID,
      });

      assert.equal(result.value, 42);
      assert.equal(result.scopeID, sessionID);
    });

    it('respects explicit scopeID', async () => {
      let agent   = await createAgent('test-get-explicit-scope');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      // Store in scope A
      await setTool.execute({ agentID: agent.id, key: 'color', value: 'red', scopeID: 'scope-a' });
      // Store in scope B
      await setTool.execute({ agentID: agent.id, key: 'color', value: 'blue', scopeID: 'scope-b' });

      let resultA = await getTool.execute({ agentID: agent.id, key: 'color', scopeID: 'scope-a' });
      let resultB = await getTool.execute({ agentID: agent.id, key: 'color', scopeID: 'scope-b' });

      assert.equal(resultA.value, 'red');
      assert.equal(resultA.scopeID, 'scope-a');
      assert.equal(resultB.value, 'blue');
      assert.equal(resultB.scopeID, 'scope-b');
    });

    it('handles corrupted JSON gracefully (returns raw string)', async () => {
      let agent = await createAgent('test-get-corrupted-json');
      let { ValueStore } = models;

      // Manually insert a row with invalid JSON
      await ValueStore.create({
        organizationID: organization.id,
        ownerType:      'Agent',
        ownerID:        agent.id,
        namespace:      'memory',
        scopeID:        '',
        key:            'broken',
        value:          '{not valid json!!!',
      });

      let getTool = instantiateTool(GetMemoryValueTool);
      let result  = await getTool.execute({ agentID: agent.id, key: 'broken', scopeID: '' });

      // Should return the raw string instead of throwing
      assert.equal(result.value, '{not valid json!!!');
    });

    it('rejects when agentID is missing', async () => {
      let tool = instantiateTool(GetMemoryValueTool);

      await assert.rejects(
        () => tool.execute({ key: 'test' }),
        (err) => {
          assert.ok(err.message.includes('agentID'));
          return true;
        },
      );
    });

    it('rejects when agent not found', async () => {
      let tool = instantiateTool(GetMemoryValueTool);

      await assert.rejects(
        () => tool.execute({ agentID: 'agt_nonexistent', key: 'test' }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // memory:setValue
  // ---------------------------------------------------------------------------

  describe('memory:setValue', () => {
    it('stores a new value', async () => {
      let agent   = await createAgent('test-set-new');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      let result = await setTool.execute({ agentID: agent.id, key: 'count', value: 99, scopeID: '' });
      assert.equal(result.key, 'count');
      assert.equal(result.value, 99);

      let fetched = await getTool.execute({ agentID: agent.id, key: 'count', scopeID: '' });
      assert.equal(fetched.value, 99);
    });

    it('updates existing value (upsert)', async () => {
      let agent   = await createAgent('test-set-upsert');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'mood', value: 'happy', scopeID: '' });
      await setTool.execute({ agentID: agent.id, key: 'mood', value: 'ecstatic', scopeID: '' });

      let result = await getTool.execute({ agentID: agent.id, key: 'mood', scopeID: '' });
      assert.equal(result.value, 'ecstatic');
    });

    it('deletes value when null', async () => {
      let agent   = await createAgent('test-set-delete');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'ephemeral', value: 'exists', scopeID: '' });

      let deleteResult = await setTool.execute({ agentID: agent.id, key: 'ephemeral', value: null, scopeID: '' });
      assert.equal(deleteResult.deleted, true);
      assert.equal(deleteResult.value, null);

      let fetched = await getTool.execute({ agentID: agent.id, key: 'ephemeral', scopeID: '' });
      assert.equal(fetched.value, null);
    });

    it('stores JSON objects', async () => {
      let agent   = await createAgent('test-set-object');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      let complexValue = { nested: { deep: true }, items: [1, 2, 3] };
      await setTool.execute({ agentID: agent.id, key: 'data', value: complexValue, scopeID: '' });

      let result = await getTool.execute({ agentID: agent.id, key: 'data', scopeID: '' });
      assert.deepStrictEqual(result.value, complexValue);
    });

    it('stores strings', async () => {
      let agent   = await createAgent('test-set-string');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'note', value: 'a simple string', scopeID: '' });

      let result = await getTool.execute({ agentID: agent.id, key: 'note', scopeID: '' });
      assert.equal(result.value, 'a simple string');
    });

    it('stores numbers', async () => {
      let agent   = await createAgent('test-set-number');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'pi', value: 3.14159, scopeID: '' });

      let result = await getTool.execute({ agentID: agent.id, key: 'pi', scopeID: '' });
      assert.equal(result.value, 3.14159);
    });

    it('stores booleans', async () => {
      let agent   = await createAgent('test-set-boolean');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'active', value: true, scopeID: '' });

      let result = await getTool.execute({ agentID: agent.id, key: 'active', scopeID: '' });
      assert.equal(result.value, true);
    });

    it('stores arrays', async () => {
      let agent   = await createAgent('test-set-array');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'tags', value: ['a', 'b', 'c'], scopeID: '' });

      let result = await getTool.execute({ agentID: agent.id, key: 'tags', scopeID: '' });
      assert.deepStrictEqual(result.value, ['a', 'b', 'c']);
    });

    it('uses memory namespace (not config)', async () => {
      let agent   = await createAgent('test-set-namespace');
      let setTool = instantiateTool(SetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'verify-ns', value: 'test', scopeID: '' });

      // Verify directly in the database
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .key.EQ('verify-ns')
        .first();

      assert.ok(entry);
      assert.equal(entry.namespace, 'memory');
      assert.notEqual(entry.namespace, 'config');
    });

    it('defaults scopeID to currentSessionID', async () => {
      let agent   = await createAgent('test-set-scope-default');
      let setTool = instantiateTool(SetMemoryValueTool);

      let sessionID = 'ses_scope_default_test';
      await setTool.execute({
        agentID:          agent.id,
        key:              'auto-scope',
        value:            'scoped-value',
        currentSessionID: sessionID,
      });

      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('auto-scope')
        .first();

      assert.ok(entry);
      assert.equal(entry.scopeID, sessionID);
    });

    it('deletes non-existent key without error', async () => {
      let agent   = await createAgent('test-set-delete-nonexistent');
      let setTool = instantiateTool(SetMemoryValueTool);

      // Should not throw
      let result = await setTool.execute({ agentID: agent.id, key: 'phantom', value: null, scopeID: '' });
      assert.equal(result.deleted, true);
      assert.equal(result.value, null);
    });

    it('rejects when agentID is missing', async () => {
      let tool = instantiateTool(SetMemoryValueTool);

      await assert.rejects(
        () => tool.execute({ key: 'test', value: 'val' }),
        (err) => {
          assert.ok(err.message.includes('agentID'));
          return true;
        },
      );
    });

    it('rejects when agent not found', async () => {
      let tool = instantiateTool(SetMemoryValueTool);

      await assert.rejects(
        () => tool.execute({ agentID: 'agt_nonexistent', key: 'test', value: 'val' }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // memory:searchValues
  // ---------------------------------------------------------------------------

  describe('memory:searchValues', () => {
    async function seedEntries(agent, entries) {
      let setTool = instantiateTool(SetMemoryValueTool);
      for (let entry of entries)
        await setTool.execute({ agentID: agent.id, ...entry });
    }

    it('returns all entries when query is empty/null', async () => {
      let agent = await createAgent('test-search-all');
      await seedEntries(agent, [
        { key: 'alpha', value: 'one', scopeID: 'scope-1' },
        { key: 'beta',  value: 'two', scopeID: 'scope-1' },
        { key: 'gamma', value: 'three', scopeID: 'scope-1' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, scopeID: 'scope-1' });

      assert.equal(result.count, 3);
      assert.equal(result.results.length, 3);
    });

    it('matches on key name', async () => {
      let agent = await createAgent('test-search-key');
      await seedEntries(agent, [
        { key: 'user-preference', value: 'dark', scopeID: '' },
        { key: 'system-setting',  value: 'auto', scopeID: '' },
        { key: 'user-name',       value: 'bob',  scopeID: '' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, query: 'user', scopeID: '' });

      assert.equal(result.count, 2);
      let keys = result.results.map((r) => r.key).sort();
      assert.deepStrictEqual(keys, ['user-name', 'user-preference']);
    });

    it('matches on value content', async () => {
      let agent = await createAgent('test-search-value');
      await seedEntries(agent, [
        { key: 'item-1', value: 'apple pie', scopeID: '' },
        { key: 'item-2', value: 'banana split', scopeID: '' },
        { key: 'item-3', value: 'apple sauce', scopeID: '' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, query: 'apple', scopeID: '' });

      assert.equal(result.count, 2);
      let keys = result.results.map((r) => r.key).sort();
      assert.deepStrictEqual(keys, ['item-1', 'item-3']);
    });

    it('respects limit', async () => {
      let agent = await createAgent('test-search-limit');
      await seedEntries(agent, [
        { key: 'a', value: '1', scopeID: '' },
        { key: 'b', value: '2', scopeID: '' },
        { key: 'c', value: '3', scopeID: '' },
        { key: 'd', value: '4', scopeID: '' },
        { key: 'e', value: '5', scopeID: '' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, limit: 2, scopeID: '' });

      assert.equal(result.results.length, 2);
      assert.equal(result.count, 5); // total count before limit
    });

    it('respects offset', async () => {
      let agent = await createAgent('test-search-offset');
      await seedEntries(agent, [
        { key: 'a', value: '1', scopeID: '' },
        { key: 'b', value: '2', scopeID: '' },
        { key: 'c', value: '3', scopeID: '' },
        { key: 'd', value: '4', scopeID: '' },
        { key: 'e', value: '5', scopeID: '' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, offset: 3, limit: 10, scopeID: '' });

      assert.equal(result.results.length, 2); // 5 total - 3 offset = 2 remaining
      assert.equal(result.count, 5);
    });

    it('returns empty results for no matches', async () => {
      let agent = await createAgent('test-search-empty');
      await seedEntries(agent, [
        { key: 'foo', value: 'bar', scopeID: '' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, query: 'zzz-no-match', scopeID: '' });

      assert.equal(result.count, 0);
      assert.equal(result.results.length, 0);
    });

    it('searches across all scopes when scopeID is undefined', async () => {
      let agent = await createAgent('test-search-all-scopes');
      await seedEntries(agent, [
        { key: 'item-a', value: 'one', scopeID: 'scope-x' },
        { key: 'item-b', value: 'two', scopeID: 'scope-y' },
        { key: 'item-c', value: 'three', scopeID: 'scope-z' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      // scopeID not provided => searches all scopes
      let result = await tool.execute({ agentID: agent.id, query: 'item' });

      assert.equal(result.count, 3);
    });

    it('searches within specific scope when scopeID is provided', async () => {
      let agent = await createAgent('test-search-specific-scope');
      await seedEntries(agent, [
        { key: 'item-a', value: 'one', scopeID: 'scope-x' },
        { key: 'item-b', value: 'two', scopeID: 'scope-y' },
        { key: 'item-c', value: 'three', scopeID: 'scope-x' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, scopeID: 'scope-x' });

      assert.equal(result.count, 2);
      let keys = result.results.map((r) => r.key).sort();
      assert.deepStrictEqual(keys, ['item-a', 'item-c']);
    });

    it('case-insensitive query matching', async () => {
      let agent = await createAgent('test-search-case');
      await seedEntries(agent, [
        { key: 'UserPreference', value: 'DARK_MODE', scopeID: '' },
        { key: 'system-config',  value: 'light', scopeID: '' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, query: 'USERPREF', scopeID: '' });

      assert.equal(result.count, 1);
      assert.equal(result.results[0].key, 'UserPreference');
    });

    it('returns parsed JSON values', async () => {
      let agent = await createAgent('test-search-json');
      await seedEntries(agent, [
        { key: 'obj', value: { nested: true }, scopeID: '' },
        { key: 'arr', value: [1, 2, 3], scopeID: '' },
      ]);

      let tool   = instantiateTool(SearchMemoryValuesTool);
      let result = await tool.execute({ agentID: agent.id, scopeID: '' });

      let objResult = result.results.find((r) => r.key === 'obj');
      let arrResult = result.results.find((r) => r.key === 'arr');

      assert.deepStrictEqual(objResult.value, { nested: true });
      assert.deepStrictEqual(arrResult.value, [1, 2, 3]);
    });

    it('rejects when agentID is missing', async () => {
      let tool = instantiateTool(SearchMemoryValuesTool);

      await assert.rejects(
        () => tool.execute({}),
        (err) => {
          assert.ok(err.message.includes('agentID'));
          return true;
        },
      );
    });

    it('rejects when agent not found', async () => {
      let tool = instantiateTool(SearchMemoryValuesTool);

      await assert.rejects(
        () => tool.execute({ agentID: 'agt_nonexistent' }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  describe('Guards', () => {
    it('memory:setValue writes to memory namespace, not config', async () => {
      let agent   = await createAgent('test-guard-namespace');
      let setTool = instantiateTool(SetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'guard-test', value: 'secret', scopeID: '' });

      let { ValueStore } = models;

      // Confirm entry exists in memory namespace
      let memoryEntry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('guard-test')
        .first();
      assert.ok(memoryEntry, 'Entry should exist in memory namespace');

      // Confirm nothing was written to config namespace
      let configEntry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('config')
        .key.EQ('guard-test')
        .first();
      assert.ok(!configEntry, 'No entry should exist in config namespace');
    });

    it('entries use ownerType=Agent and namespace=memory', async () => {
      let agent   = await createAgent('test-guard-owner');
      let setTool = instantiateTool(SetMemoryValueTool);

      await setTool.execute({ agentID: agent.id, key: 'owner-check', value: 'val', scopeID: '' });

      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerID.EQ(agent.id)
        .key.EQ('owner-check')
        .first();

      assert.ok(entry);
      assert.equal(entry.ownerType, 'Agent');
      assert.equal(entry.namespace, 'memory');
      assert.equal(entry.ownerID, agent.id);
    });

    it('memory tools do not interfere with agent config', async () => {
      let agent   = await createAgent('test-guard-isolation');
      let setTool = instantiateTool(SetMemoryValueTool);

      // Set a memory value with key 'model' (which is also a config key)
      await setTool.execute({ agentID: agent.id, key: 'model', value: 'gpt-9000', scopeID: '' });

      // Agent config should be unaffected
      let config = await agent.getSafeConfig();
      assert.notEqual(config.model, 'gpt-9000');
    });
  });
});
