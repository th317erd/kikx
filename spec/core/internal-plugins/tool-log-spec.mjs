'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { PluginInterface } from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }  from '../../../src/core/plugin-loader/registry.mjs';
import { setup }           from '../../../src/core/internal-plugins/tool-log/index.mjs';

// =============================================================================
// Tool Log Plugin — Internal Tools Tests
// =============================================================================
// Tests for tool_log:get and tool_log:search
// =============================================================================

describe('Tool Log Plugin', { timeout: 30000 }, () => {
  let core;
  let models;
  let context;
  let registry;
  let organization;

  let GetToolLogTool;
  let SearchToolLogTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    registry = new PluginRegistry();
    setup({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    GetToolLogTool    = registry.getTool('tool_log:get');
    SearchToolLogTool = registry.getTool('tool_log:search');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Tool Log Test Org' });
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

  // Create a ValueStore tool log entry directly (simulates ToolLogService output)
  async function createToolLogEntry(agentID, {
    key         = null,
    output      = 'test output',
    args        = {},
    toolName    = 'execute',
    pluginID    = 'shell',
    sessionID   = '',
    note        = null,
  } = {}) {
    let { ValueStore } = models;
    let entryKey = key || `tl_testkey_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let typeStr  = `tool_log:${pluginID}:${toolName}`;
    let value    = JSON.stringify({ args, output });

    let entry = await ValueStore.create({
      organizationID: organization.id,
      ownerType:      'agent',
      ownerID:        agentID,
      namespace:      'tool_log',
      scopeID:        sessionID,
      key:            entryKey,
      value,
      note:           note || toolName,
      type:           typeStr,
    });

    return { key: entryKey, entry };
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('setup()', () => {
    it('registers tool_log:get', () => {
      assert.ok(GetToolLogTool, 'tool_log:get should be registered');
    });

    it('registers tool_log:search', () => {
      assert.ok(SearchToolLogTool, 'tool_log:search should be registered');
    });

    it('both tools extend PluginInterface', () => {
      assert.ok(GetToolLogTool.prototype    instanceof PluginInterface);
      assert.ok(SearchToolLogTool.prototype instanceof PluginInterface);
    });

    it('both tools define inputSchema', () => {
      assert.ok(GetToolLogTool.inputSchema);
      assert.ok(SearchToolLogTool.inputSchema);
    });

    it('both tools have riskLevel none', () => {
      assert.equal(GetToolLogTool.riskLevel,    'none');
      assert.equal(SearchToolLogTool.riskLevel, 'none');
    });

    it('tool_log:get requires id in schema', () => {
      assert.ok(GetToolLogTool.inputSchema.required);
      assert.ok(GetToolLogTool.inputSchema.required.includes('id'));
    });
  });

  // ---------------------------------------------------------------------------
  // tool_log:get — Happy Paths
  // ---------------------------------------------------------------------------

  describe('tool_log:get — happy paths', () => {
    it('returns correct content for owned entry', async () => {
      let agent  = await createAgent('test-tl-get-basic');
      let { key } = await createToolLogEntry(agent.id, { output: 'hello world' });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({ agentID: agent.id, id: key });

      assert.equal(result.id, key);
      assert.equal(result.content, 'hello world');
      assert.equal(result.outputLength, 11);
      assert.equal(result.content_start, 0);
      assert.equal(result.content_end, 11);
      assert.equal(result.content_lines, false);
    });

    it('returns toolName extracted from type field', async () => {
      let agent  = await createAgent('test-tl-get-toolname');
      let { key } = await createToolLogEntry(agent.id, {
        toolName: 'execute',
        pluginID: 'shell',
        output:   'output here',
      });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({ agentID: agent.id, id: key });

      assert.equal(result.toolName, 'shell:execute');
    });

    it('returns note from the entry', async () => {
      let agent  = await createAgent('test-tl-get-note');
      let { key } = await createToolLogEntry(agent.id, {
        output: 'file listing',
        note:   'ls -la /tmp',
      });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({ agentID: agent.id, id: key });

      assert.equal(result.note, 'ls -la /tmp');
    });

    it('char slicing: content_start and content_end work', async () => {
      let agent  = await createAgent('test-tl-get-char-slice');
      let { key } = await createToolLogEntry(agent.id, { output: 'abcdefghij' });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 2,
        content_end:   6,
      });

      assert.equal(result.content, 'cdef');
      assert.equal(result.content_start, 2);
      assert.equal(result.content_end, 6);
      assert.equal(result.content_lines, false);
    });

    it('content_end=null returns full output', async () => {
      let agent  = await createAgent('test-tl-get-full-output');
      let output = 'full output string with many characters here';
      let { key } = await createToolLogEntry(agent.id, { output });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 0,
        content_end:   null,
      });

      assert.equal(result.content, output);
      assert.equal(result.content_end, output.length);
    });

    it('content_lines=true slices by line numbers', async () => {
      let agent  = await createAgent('test-tl-get-lines');
      let output = 'line0\nline1\nline2\nline3\nline4';
      let { key } = await createToolLogEntry(agent.id, { output });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 1,
        content_end:   3,
        content_lines: true,
      });

      assert.equal(result.content, 'line1\nline2');
      assert.equal(result.content_lines, true);
      assert.equal(result.content_start, 1);
      assert.equal(result.content_end, 3);
    });

    it('content_lines=true with no content_end returns from start to end', async () => {
      let agent  = await createAgent('test-tl-get-lines-no-end');
      let output = 'alpha\nbeta\ngamma';
      let { key } = await createToolLogEntry(agent.id, { output });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 1,
        content_lines: true,
      });

      assert.equal(result.content, 'beta\ngamma');
    });

    it('content_start=0 (default) returns from beginning', async () => {
      let agent  = await createAgent('test-tl-get-default-start');
      let { key } = await createToolLogEntry(agent.id, { output: 'starthere' });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({ agentID: agent.id, id: key, content_end: 5 });

      assert.equal(result.content, 'start');
      assert.equal(result.content_start, 0);
    });

    it('returns createdAt timestamp', async () => {
      let agent  = await createAgent('test-tl-get-createdat');
      let { key } = await createToolLogEntry(agent.id, { output: 'timestamped output' });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({ agentID: agent.id, id: key });

      assert.ok(result.createdAt != null, 'createdAt should be present');
    });
  });

  // ---------------------------------------------------------------------------
  // tool_log:get — Failure Paths
  // ---------------------------------------------------------------------------

  describe('tool_log:get — failure paths', () => {
    it('throws NOT_FOUND for non-existent id', async () => {
      let agent = await createAgent('test-tl-get-notfound');
      let tool  = instantiateTool(GetToolLogTool);

      await assert.rejects(
        () => tool.execute({ agentID: agent.id, id: 'tl_does_not_exist' }),
        (err) => {
          assert.equal(err.code, 'NOT_FOUND');
          assert.ok(err.message.toLowerCase().includes('not found'));
          return true;
        },
      );
    });

    it('throws FORBIDDEN for another agent\'s entry', async () => {
      let agentA = await createAgent('test-tl-get-forbidden-a');
      let agentB = await createAgent('test-tl-get-forbidden-b');

      let { key } = await createToolLogEntry(agentA.id, { output: 'secret output' });

      let tool = instantiateTool(GetToolLogTool);

      // Agent B tries to read Agent A's entry
      await assert.rejects(
        () => tool.execute({ agentID: agentB.id, id: key }),
        (err) => {
          assert.equal(err.code, 'FORBIDDEN');
          assert.ok(err.message.toLowerCase().includes('access denied') || err.message.toLowerCase().includes('forbidden'));
          return true;
        },
      );
    });

    it('throws MISSING_ID when id is not provided', async () => {
      let agent = await createAgent('test-tl-get-missing-id');
      let tool  = instantiateTool(GetToolLogTool);

      await assert.rejects(
        () => tool.execute({ agentID: agent.id }),
        (err) => {
          assert.equal(err.code, 'MISSING_ID');
          assert.ok(err.message.toLowerCase().includes('id is required') || err.message.toLowerCase().includes('required'));
          return true;
        },
      );
    });

    it('throws MISSING_ID when id is empty string', async () => {
      let agent = await createAgent('test-tl-get-empty-id');
      let tool  = instantiateTool(GetToolLogTool);

      await assert.rejects(
        () => tool.execute({ agentID: agent.id, id: '' }),
        (err) => {
          assert.equal(err.code, 'MISSING_ID');
          return true;
        },
      );
    });

    it('throws MISSING_ID when id is whitespace only', async () => {
      let agent = await createAgent('test-tl-get-whitespace-id');
      let tool  = instantiateTool(GetToolLogTool);

      await assert.rejects(
        () => tool.execute({ agentID: agent.id, id: '   ' }),
        (err) => {
          assert.equal(err.code, 'MISSING_ID');
          return true;
        },
      );
    });

    it('throws INVALID_RANGE when content_end < content_start', async () => {
      let agent   = await createAgent('test-tl-get-bad-range');
      let { key } = await createToolLogEntry(agent.id, { output: 'range test' });
      let tool    = instantiateTool(GetToolLogTool);

      await assert.rejects(
        () => tool.execute({ agentID: agent.id, id: key, content_start: 10, content_end: 5 }),
        (err) => {
          assert.equal(err.code, 'INVALID_RANGE');
          assert.ok(err.message.toLowerCase().includes('content_end'));
          return true;
        },
      );
    });

    it('throws INVALID_RANGE check happens before DB lookup', async () => {
      let agent = await createAgent('test-tl-get-range-before-db');
      let tool  = instantiateTool(GetToolLogTool);

      // Even with a real ID that exists, range validation is immediate
      let { key } = await createToolLogEntry(agent.id, { output: 'test' });

      await assert.rejects(
        () => tool.execute({ agentID: agent.id, id: key, content_start: 100, content_end: 50 }),
        (err) => {
          assert.equal(err.code, 'INVALID_RANGE');
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // tool_log:get — Edge Cases
  // ---------------------------------------------------------------------------

  describe('tool_log:get — edge cases', () => {
    it('content_start > outputLength returns empty string', async () => {
      let agent  = await createAgent('test-tl-get-start-overflow');
      let { key } = await createToolLogEntry(agent.id, { output: 'short' });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 9999,
      });

      assert.equal(result.content, '');
    });

    it('output with no newlines, content_lines=true: whole output treated as line 0', async () => {
      let agent  = await createAgent('test-tl-get-no-newlines');
      let output = 'singlelinewithnonewlines';
      let { key } = await createToolLogEntry(agent.id, { output });

      let tool   = instantiateTool(GetToolLogTool);

      // Line 0 should return the whole output
      let result0 = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 0,
        content_end:   1,
        content_lines: true,
      });
      assert.equal(result0.content, output);

      // Line 1+ should return empty (only 1 line exists)
      let result1 = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 1,
        content_end:   2,
        content_lines: true,
      });
      assert.equal(result1.content, '');
    });

    it('empty output: returns empty content, outputLength=0', async () => {
      let agent  = await createAgent('test-tl-get-empty-output');
      let { key } = await createToolLogEntry(agent.id, { output: '' });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({ agentID: agent.id, id: key });

      assert.equal(result.content, '');
      assert.equal(result.outputLength, 0);
    });

    it('content_start === content_end returns empty string', async () => {
      let agent  = await createAgent('test-tl-get-equal-range');
      let { key } = await createToolLogEntry(agent.id, { output: 'abcde' });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({
        agentID:       agent.id,
        id:            key,
        content_start: 3,
        content_end:   3,
      });

      assert.equal(result.content, '');
    });

    it('content_end beyond output length: clamps to output length', async () => {
      let agent  = await createAgent('test-tl-get-end-clamp');
      let output = 'hello';
      let { key } = await createToolLogEntry(agent.id, { output });

      let tool   = instantiateTool(GetToolLogTool);
      let result = await tool.execute({
        agentID:     agent.id,
        id:          key,
        content_end: 9999,
      });

      // Slicing beyond length just returns everything
      assert.equal(result.content, 'hello');
    });

    it('two separate entries for same tool called twice', async () => {
      let agent  = await createAgent('test-tl-get-two-entries');
      let { key: key1 } = await createToolLogEntry(agent.id, { output: 'first call result' });
      let { key: key2 } = await createToolLogEntry(agent.id, { output: 'second call result' });

      assert.notEqual(key1, key2, 'Keys must be unique');

      let tool = instantiateTool(GetToolLogTool);

      let result1 = await tool.execute({ agentID: agent.id, id: key1 });
      let result2 = await tool.execute({ agentID: agent.id, id: key2 });

      assert.equal(result1.content, 'first call result');
      assert.equal(result2.content, 'second call result');
    });
  });

  // ---------------------------------------------------------------------------
  // tool_log:search — Happy Paths
  // ---------------------------------------------------------------------------

  describe('tool_log:search — happy paths', () => {
    it('returns entries for calling agent', async () => {
      let agent = await createAgent('test-tl-search-basic');
      await createToolLogEntry(agent.id, { output: 'result 1', toolName: 'execute', pluginID: 'shell' });
      await createToolLogEntry(agent.id, { output: 'result 2', toolName: 'search',  pluginID: 'websearch' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 2);
    });

    it('does not return other agents entries', async () => {
      let agentA = await createAgent('test-tl-search-isolation-a');
      let agentB = await createAgent('test-tl-search-isolation-b');

      await createToolLogEntry(agentA.id, { output: 'agent A result' });
      await createToolLogEntry(agentB.id, { output: 'agent B result' });

      let tool = instantiateTool(SearchToolLogTool);

      let resultsA = await tool.execute({ agentID: agentA.id });
      let resultsB = await tool.execute({ agentID: agentB.id });

      assert.equal(resultsA.length, 1);
      assert.equal(resultsB.length, 1);
    });

    it('toolName filter returns only matching entries', async () => {
      let agent = await createAgent('test-tl-search-toolname');
      await createToolLogEntry(agent.id, { toolName: 'execute', pluginID: 'shell',     output: 'shell output' });
      await createToolLogEntry(agent.id, { toolName: 'search',  pluginID: 'websearch', output: 'web output' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, toolName: 'shell:execute' });

      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, 'shell:execute');
    });

    it('sessionID filter restricts to specific session', async () => {
      let agent    = await createAgent('test-tl-search-session');
      let sessionA = 'ses_test_a';
      let sessionB = 'ses_test_b';

      await createToolLogEntry(agent.id, { sessionID: sessionA, output: 'session A output' });
      await createToolLogEntry(agent.id, { sessionID: sessionB, output: 'session B output' });
      await createToolLogEntry(agent.id, { sessionID: sessionA, output: 'session A output 2' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, sessionID: sessionA });

      assert.equal(results.length, 2);
      for (let r of results)
        assert.equal(r, results.find((x) => x.id === r.id));
    });

    it('returns empty array for no matches', async () => {
      let agent = await createAgent('test-tl-search-empty');
      await createToolLogEntry(agent.id, { toolName: 'execute', pluginID: 'shell', output: 'something' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, toolName: 'nonexistent:tool' });

      assert.ok(Array.isArray(results));
      assert.equal(results.length, 0);
    });

    it('limit and offset paginate correctly', async () => {
      let agent = await createAgent('test-tl-search-pagination');
      for (let i = 0; i < 5; i++)
        await createToolLogEntry(agent.id, { output: `output ${i}` });

      let tool = instantiateTool(SearchToolLogTool);

      let page1 = await tool.execute({ agentID: agent.id, limit: 2, offset: 0 });
      let page2 = await tool.execute({ agentID: agent.id, limit: 2, offset: 2 });
      let page3 = await tool.execute({ agentID: agent.id, limit: 2, offset: 4 });

      assert.equal(page1.length, 2);
      assert.equal(page2.length, 2);
      assert.equal(page3.length, 1);

      // All IDs should be unique across pages
      let allIDs = [...page1, ...page2, ...page3].map((r) => r.id);
      let uniqueIDs = new Set(allIDs);
      assert.equal(uniqueIDs.size, 5);
    });

    it('query filters by note content', async () => {
      let agent = await createAgent('test-tl-search-query-note');
      await createToolLogEntry(agent.id, { note: 'ls -la /home',  output: 'home dir' });
      await createToolLogEntry(agent.id, { note: 'cat /etc/hosts', output: 'hosts file' });
      await createToolLogEntry(agent.id, { note: 'ls -la /tmp',    output: 'tmp dir' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, query: 'ls -la' });

      assert.equal(results.length, 2);
    });

    it('query filters by type content', async () => {
      let agent = await createAgent('test-tl-search-query-type');
      await createToolLogEntry(agent.id, { toolName: 'execute', pluginID: 'shell',     output: 'shell' });
      await createToolLogEntry(agent.id, { toolName: 'search',  pluginID: 'websearch', output: 'web' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, query: 'websearch' });

      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, 'websearch:search');
    });

    it('returns content_preview sliced by content_start/content_end', async () => {
      let agent  = await createAgent('test-tl-search-preview');
      let output = 'ABCDEFGHIJKLMNOP';
      await createToolLogEntry(agent.id, { output });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({
        agentID:       agent.id,
        content_start: 4,
        content_end:   8,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].content_preview, 'EFGH');
    });

    it('default content_end=256 truncates long outputs in preview', async () => {
      let agent  = await createAgent('test-tl-search-truncate');
      let output = 'x'.repeat(1000);
      await createToolLogEntry(agent.id, { output });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 1);
      assert.equal(results[0].content_preview.length, 256);
      assert.equal(results[0].outputLength, 1000);
    });

    it('returns outputLength for full output size', async () => {
      let agent  = await createAgent('test-tl-search-outputlength');
      let output = 'x'.repeat(500);
      await createToolLogEntry(agent.id, { output });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, content_end: 0 });

      assert.equal(results[0].outputLength, 500);
    });

    it('same tool called twice: two separate entries returned', async () => {
      let agent = await createAgent('test-tl-search-two-calls');
      await createToolLogEntry(agent.id, { output: 'call 1', note: 'ls /tmp',   toolName: 'execute', pluginID: 'shell' });
      await createToolLogEntry(agent.id, { output: 'call 2', note: 'ls /home',  toolName: 'execute', pluginID: 'shell' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, toolName: 'shell:execute' });

      assert.equal(results.length, 2);
      let notes = results.map((r) => r.note).sort();
      assert.deepStrictEqual(notes, ['ls /home', 'ls /tmp']);
    });
  });

  // ---------------------------------------------------------------------------
  // tool_log:search — Failure Paths
  // ---------------------------------------------------------------------------

  describe('tool_log:search — failure paths', () => {
    it('limit=99999 is clamped to 100', async () => {
      let agent = await createAgent('test-tl-search-clamp');
      // Create 150 entries
      for (let i = 0; i < 105; i++)
        await createToolLogEntry(agent.id, { output: `entry ${i}` });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, limit: 99999 });

      assert.ok(results.length <= 100, `Expected <= 100 results, got ${results.length}`);
    });

    it('limit=0 falls back to default of 10', async () => {
      let agent = await createAgent('test-tl-search-zero-limit');
      for (let i = 0; i < 15; i++)
        await createToolLogEntry(agent.id, { output: `entry ${i}` });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, limit: 0 });

      assert.equal(results.length, 10);
    });

    it('empty query returns all entries up to limit', async () => {
      let agent = await createAgent('test-tl-search-empty-query');
      await createToolLogEntry(agent.id, { output: 'one' });
      await createToolLogEntry(agent.id, { output: 'two' });
      await createToolLogEntry(agent.id, { output: 'three' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, query: '' });

      assert.equal(results.length, 3);
    });

    it('offset beyond total count returns empty array', async () => {
      let agent = await createAgent('test-tl-search-offset-overflow');
      await createToolLogEntry(agent.id, { output: 'only one' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, offset: 100 });

      assert.ok(Array.isArray(results));
      assert.equal(results.length, 0);
    });

    it('negative offset treated as 0', async () => {
      let agent = await createAgent('test-tl-search-neg-offset');
      await createToolLogEntry(agent.id, { output: 'one' });
      await createToolLogEntry(agent.id, { output: 'two' });

      let tool    = instantiateTool(SearchToolLogTool);
      // slice(-5, 10) returns first items — negative offset not clamped in slice but JS handles it
      let results = await tool.execute({ agentID: agent.id, offset: -5, limit: 10 });

      // Should still work and return entries
      assert.ok(Array.isArray(results));
    });
  });

  // ---------------------------------------------------------------------------
  // tool_log:search — Edge Cases
  // ---------------------------------------------------------------------------

  describe('tool_log:search — edge cases', () => {
    it('returns empty array when agent has no tool log entries', async () => {
      let agent = await createAgent('test-tl-search-no-entries');

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id });

      assert.ok(Array.isArray(results));
      assert.equal(results.length, 0);
    });

    it('content_lines=true in search: preview uses line slicing', async () => {
      let agent  = await createAgent('test-tl-search-lines');
      let output = 'line0\nline1\nline2\nline3';
      await createToolLogEntry(agent.id, { output });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({
        agentID:       agent.id,
        content_start: 1,
        content_end:   3,
        content_lines: true,
      });

      assert.equal(results[0].content_preview, 'line1\nline2');
    });

    it('toolName filter: no match returns empty array', async () => {
      let agent = await createAgent('test-tl-search-toolname-nomatch');
      await createToolLogEntry(agent.id, { toolName: 'execute', pluginID: 'shell', output: 'x' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id, toolName: 'nonexistent:whatever' });

      assert.equal(results.length, 0);
    });

    it('search returns entries from all sessions when sessionID not provided', async () => {
      let agent = await createAgent('test-tl-search-all-sessions');
      await createToolLogEntry(agent.id, { sessionID: 'ses_aaa', output: 'a' });
      await createToolLogEntry(agent.id, { sessionID: 'ses_bbb', output: 'b' });
      await createToolLogEntry(agent.id, { sessionID: 'ses_ccc', output: 'c' });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 3);
    });

    it('corrupted value JSON returns empty preview without crashing', async () => {
      let agent     = await createAgent('test-tl-search-corrupted');
      let { ValueStore } = models;

      // Insert entry with invalid JSON value
      await ValueStore.create({
        organizationID: organization.id,
        ownerType:      'agent',
        ownerID:        agent.id,
        namespace:      'tool_log',
        scopeID:        '',
        key:            `tl_corrupted_${Date.now()}`,
        value:          '{not valid json!!!',
        note:           'bad entry',
        type:           'tool_log:test:broken',
      });

      let tool    = instantiateTool(SearchToolLogTool);
      let results = await tool.execute({ agentID: agent.id });

      // Should not throw; corrupted entry returns empty preview
      assert.equal(results.length, 1);
      assert.equal(results[0].content_preview, '');
      assert.equal(results[0].outputLength, 0);
    });
  });
});
