'use strict';

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { PluginInterface } from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }  from '../../../src/core/plugin-loader/registry.mjs';
import { setup }           from '../../../src/core/internal-plugins/tool-log/index.mjs';

// =============================================================================
// Tool Log Search — Solr Rebacking Tests
// =============================================================================
// Tests for SearchToolLogTool with Solr integration and SQLite fallback.
// =============================================================================

describe('tool_log:search — Solr rebacking', { timeout: 30000 }, () => {
  let core;
  let models;
  let baseContext;
  let organization;

  let SearchToolLogTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    baseContext = core.getContext();

    let registry = new PluginRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });
    setup((cb) => cb({ registry, context: baseContext }));

    SearchToolLogTool = registry.getTool('tool_log:search');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Solr Search Test Org' });
  });

  async function createAgent(name) {
    return models.Agent.create({
      organizationID: organization.id,
      name:           name,
      pluginID:       'mock-agent',
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

  // Helper to create a tool instance with a custom context that may include solrService
  function instantiateTool(solrService) {
    return new SearchToolLogTool({
      getProperty: (key) => {
        if (key === 'solrService')
          return solrService;

        return baseContext.getProperty(key);
      },
    });
  }

  // Build a mock SolrService that returns specified doc IDs
  function createMockSolrService(docIDs = [], { numFound = null } = {}) {
    return {
      search: mock.fn(async () => ({
        response: {
          numFound: (numFound != null) ? numFound : docIDs.length,
          start:    0,
          docs:     docIDs.map((id) => ({ id, doc_type: 'value_store' })),
        },
      })),
    };
  }

  // Build a mock SolrService that throws on search
  function createFailingSolrService(errorMessage = 'Solr connection refused') {
    return {
      search: mock.fn(async () => {
        throw new Error(errorMessage);
      }),
    };
  }

  // =========================================================================
  // Happy paths — Solr available
  // =========================================================================

  describe('Solr path — happy paths', () => {
    it('basic query uses Solr eDisMax search', async () => {
      let agent   = await createAgent('test-solr-basic');
      let { key } = await createToolLogEntry(agent.id, { output: 'hello solr' });

      let mockSolr = createMockSolrService([ key ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({ agentID: agent.id, query: 'hello' });

      assert.equal(results.length, 1);
      assert.equal(results[0].id, key);
      assert.equal(results[0].content_preview, 'hello solr');

      // Verify Solr was called with the query
      let call = mockSolr.search.mock.calls[0];
      assert.equal(call.arguments[0], 'hello');
    });

    it('toolName filter produces correct fq filter', async () => {
      let agent   = await createAgent('test-solr-toolname');
      let { key } = await createToolLogEntry(agent.id, {
        toolName: 'execute',
        pluginID: 'shell',
        output:   'shell result',
      });

      let mockSolr = createMockSolrService([ key ]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, toolName: 'shell:execute' });

      let call = mockSolr.search.mock.calls[0];
      let opts = call.arguments[1];

      // Should have fq for type:"tool_log:shell:execute"
      let fqs = opts.filterQueries;
      assert.ok(
        fqs.some((fq) => fq.includes('type:') && fq.includes('tool_log:shell:execute')),
        `Expected type fq with tool_log:shell:execute, got: ${JSON.stringify(fqs)}`,
      );
    });

    it('sessionID filter produces correct fq filter', async () => {
      let agent   = await createAgent('test-solr-session');
      let { key } = await createToolLogEntry(agent.id, {
        sessionID: 'ses_abc123',
        output:    'session result',
      });

      let mockSolr = createMockSolrService([ key ]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, sessionID: 'ses_abc123' });

      let call = mockSolr.search.mock.calls[0];
      let fqs  = call.arguments[1].filterQueries;
      assert.ok(
        fqs.some((fq) => fq === 'sessionID:ses_abc123'),
        `Expected sessionID fq, got: ${JSON.stringify(fqs)}`,
      );
    });

    it('before date filter produces timestamp range fq', async () => {
      let agent   = await createAgent('test-solr-before');
      let { key } = await createToolLogEntry(agent.id, { output: 'old entry' });

      let beforeDate = '2025-06-15T12:00:00Z';
      let mockSolr   = createMockSolrService([ key ]);
      let tool       = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, before: beforeDate });

      let call = mockSolr.search.mock.calls[0];
      let fqs  = call.arguments[1].filterQueries;

      let expectedMs = new Date(beforeDate).getTime();
      assert.ok(
        fqs.some((fq) => fq === `timestamp:[* TO ${expectedMs}]`),
        `Expected before timestamp fq, got: ${JSON.stringify(fqs)}`,
      );
    });

    it('after date filter produces timestamp range fq', async () => {
      let agent   = await createAgent('test-solr-after');
      let { key } = await createToolLogEntry(agent.id, { output: 'new entry' });

      let afterDate = '2025-01-01T00:00:00Z';
      let mockSolr  = createMockSolrService([ key ]);
      let tool      = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, after: afterDate });

      let call = mockSolr.search.mock.calls[0];
      let fqs  = call.arguments[1].filterQueries;

      let expectedMs = new Date(afterDate).getTime();
      assert.ok(
        fqs.some((fq) => fq === `timestamp:[${expectedMs} TO *]`),
        `Expected after timestamp fq, got: ${JSON.stringify(fqs)}`,
      );
    });

    it('limit maps to rows parameter', async () => {
      let agent = await createAgent('test-solr-limit');
      await createToolLogEntry(agent.id, { output: 'entry' });

      let mockSolr = createMockSolrService([]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, limit: 25 });

      let call = mockSolr.search.mock.calls[0];
      assert.equal(call.arguments[1].rows, 25);
    });

    it('offset maps to start parameter', async () => {
      let agent = await createAgent('test-solr-offset');
      await createToolLogEntry(agent.id, { output: 'entry' });

      let mockSolr = createMockSolrService([]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, offset: 15 });

      let call = mockSolr.search.mock.calls[0];
      assert.equal(call.arguments[1].start, 15);
    });

    it('response shape matches SQLite path (backwards compatible)', async () => {
      let agent   = await createAgent('test-solr-shape');
      let { key } = await createToolLogEntry(agent.id, {
        output:   'shape test output',
        note:     'ls -la /tmp',
        toolName: 'execute',
        pluginID: 'shell',
      });

      let mockSolr = createMockSolrService([ key ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 1);
      let result = results[0];

      // Verify all required fields are present
      assert.equal(result.id, key);
      assert.equal(result.toolName, 'shell:execute');
      assert.equal(result.note, 'ls -la /tmp');
      assert.equal(result.outputLength, 'shape test output'.length);
      assert.equal(typeof result.content_preview, 'string');
      assert.equal(typeof result.content_start, 'number');
      assert.equal(typeof result.content_end, 'number');
      assert.equal(typeof result.content_lines, 'boolean');
      assert.ok(result.createdAt != null, 'createdAt should be present');
    });

    it('always includes doc_type and namespace fqs', async () => {
      let agent = await createAgent('test-solr-base-fqs');
      await createToolLogEntry(agent.id, { output: 'x' });

      let mockSolr = createMockSolrService([]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id });

      let call = mockSolr.search.mock.calls[0];
      let fqs  = call.arguments[1].filterQueries;

      assert.ok(
        fqs.some((fq) => fq === 'doc_type:value_store'),
        `Expected doc_type fq, got: ${JSON.stringify(fqs)}`,
      );
      assert.ok(
        fqs.some((fq) => fq === 'namespace:tool_log'),
        `Expected namespace fq, got: ${JSON.stringify(fqs)}`,
      );
    });

    it('Solr returns IDs, full records fetched from DB', async () => {
      let agent    = await createAgent('test-solr-db-fetch');
      let { key: key1 } = await createToolLogEntry(agent.id, { output: 'first',  note: 'note1' });
      let { key: key2 } = await createToolLogEntry(agent.id, { output: 'second', note: 'note2' });

      let mockSolr = createMockSolrService([ key1, key2 ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 2);

      // Verify content came from DB, not Solr
      let notes = results.map((r) => r.note).sort();
      assert.deepStrictEqual(notes, ['note1', 'note2']);
    });

    it('content_start and content_end apply to Solr path results', async () => {
      let agent   = await createAgent('test-solr-content-slice');
      let { key } = await createToolLogEntry(agent.id, { output: 'ABCDEFGHIJKLMNOP' });

      let mockSolr = createMockSolrService([ key ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({
        agentID:       agent.id,
        content_start: 4,
        content_end:   8,
      });

      assert.equal(results[0].content_preview, 'EFGH');
      assert.equal(results[0].content_start, 4);
      assert.equal(results[0].content_end, 8);
    });

    it('no query param sends *:* as Solr query', async () => {
      let agent = await createAgent('test-solr-no-query');
      await createToolLogEntry(agent.id, { output: 'entry' });

      let mockSolr = createMockSolrService([]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id });

      let call = mockSolr.search.mock.calls[0];
      assert.equal(call.arguments[0], '*:*');
    });
  });

  // =========================================================================
  // Fallback paths
  // =========================================================================

  describe('Fallback to SQLite', () => {
    it('SolrService is null — uses SQLite path', async () => {
      let agent = await createAgent('test-fallback-null');
      await createToolLogEntry(agent.id, { output: 'sqlite result' });

      let tool    = instantiateTool(null);
      let results = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 1);
      assert.equal(results[0].content_preview.startsWith('sqlite result'), true);
    });

    it('SolrService is undefined — uses SQLite path', async () => {
      let tool    = instantiateTool(undefined);
      let agent   = await createAgent('test-fallback-undef');
      await createToolLogEntry(agent.id, { output: 'sqlite fallback' });

      let results = await tool.execute({ agentID: agent.id });
      assert.equal(results.length, 1);
    });

    it('SolrService.search() throws — falls back to SQLite and logs warning', async () => {
      let agent = await createAgent('test-fallback-throw');
      await createToolLogEntry(agent.id, { output: 'fallback content' });

      let mockSolr = createFailingSolrService('ECONNREFUSED');

      // Capture console.warn
      let warnings = [];
      let originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        let tool    = instantiateTool(mockSolr);
        let results = await tool.execute({ agentID: agent.id });

        // Should have used SQLite fallback
        assert.equal(results.length, 1);
        assert.ok(results[0].content_preview.startsWith('fallback content'));

        // Should have logged a warning
        assert.ok(
          warnings.some((w) => w.includes('tool_log:search') && w.includes('Solr') && w.includes('ECONNREFUSED')),
          `Expected warning about Solr fallback, got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    it('SQLite fallback still applies all filters', async () => {
      let agent = await createAgent('test-fallback-filters');
      await createToolLogEntry(agent.id, {
        toolName:  'execute',
        pluginID:  'shell',
        sessionID: 'ses_target',
        output:    'target',
      });
      await createToolLogEntry(agent.id, {
        toolName:  'search',
        pluginID:  'websearch',
        sessionID: 'ses_other',
        output:    'other',
      });

      let mockSolr = createFailingSolrService('timeout');

      // Suppress warning output
      let originalWarn = console.warn;
      console.warn = () => {};

      try {
        let tool    = instantiateTool(mockSolr);
        let results = await tool.execute({
          agentID:   agent.id,
          toolName:  'shell:execute',
          sessionID: 'ses_target',
        });

        assert.equal(results.length, 1);
        assert.equal(results[0].toolName, 'shell:execute');
      } finally {
        console.warn = originalWarn;
      }
    });

    it('Solr returns IDs not found in DB — those entries are silently skipped', async () => {
      let agent   = await createAgent('test-solr-missing-ids');
      let { key } = await createToolLogEntry(agent.id, { output: 'real entry' });

      // Solr returns a real ID and a ghost ID
      let mockSolr = createMockSolrService([ key, 'tl_nonexistent_ghost_99999' ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({ agentID: agent.id });

      // Only the real entry should appear
      assert.equal(results.length, 1);
      assert.equal(results[0].id, key);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('Edge cases', () => {
    it('empty query (no params) returns recent tool logs via Solr', async () => {
      let agent   = await createAgent('test-edge-empty');
      let { key } = await createToolLogEntry(agent.id, { output: 'recent entry' });

      let mockSolr = createMockSolrService([ key ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 1);
    });

    it('toolName with colons (e.g. "shell:execute") properly handled in Solr fq', async () => {
      let agent   = await createAgent('test-edge-colons');
      let { key } = await createToolLogEntry(agent.id, {
        toolName: 'execute',
        pluginID: 'shell',
        output:   'colon test',
      });

      let mockSolr = createMockSolrService([ key ]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, toolName: 'shell:execute' });

      let call = mockSolr.search.mock.calls[0];
      let fqs  = call.arguments[1].filterQueries;

      // The type fq should use quoting to handle colons
      let typeFq = fqs.find((fq) => fq.startsWith('type:'));
      assert.ok(typeFq, 'Should have a type filter query');
      assert.ok(
        typeFq.includes('"tool_log:shell:execute"'),
        `Type fq should quote the value to handle colons, got: ${typeFq}`,
      );
    });

    it('limit: 0 falls back to default 10 (same as SQLite path)', async () => {
      let agent = await createAgent('test-edge-limit-zero');
      await createToolLogEntry(agent.id, { output: 'x' });

      let mockSolr = createMockSolrService([]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, limit: 0 });

      let call = mockSolr.search.mock.calls[0];
      assert.equal(call.arguments[1].rows, 10);
    });

    it('limit > 100 is capped at 100', async () => {
      let agent = await createAgent('test-edge-limit-cap');
      await createToolLogEntry(agent.id, { output: 'x' });

      let mockSolr = createMockSolrService([]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id, limit: 500 });

      let call = mockSolr.search.mock.calls[0];
      assert.equal(call.arguments[1].rows, 100);
    });

    it('Solr and SQLite produce same response shape', async () => {
      let agent   = await createAgent('test-edge-shape-compare');
      let { key } = await createToolLogEntry(agent.id, {
        output:   'comparison output',
        note:     'compare note',
        toolName: 'execute',
        pluginID: 'shell',
      });

      // Solr path
      let mockSolr    = createMockSolrService([ key ]);
      let solrTool    = instantiateTool(mockSolr);
      let solrResults = await solrTool.execute({ agentID: agent.id });

      // SQLite path
      let sqliteTool    = instantiateTool(null);
      let sqliteResults = await sqliteTool.execute({ agentID: agent.id });

      assert.equal(solrResults.length, 1);
      assert.equal(sqliteResults.length, 1);

      let solrR   = solrResults[0];
      let sqliteR = sqliteResults[0];

      // Same fields present
      let solrKeys   = Object.keys(solrR).sort();
      let sqliteKeys = Object.keys(sqliteR).sort();
      assert.deepStrictEqual(solrKeys, sqliteKeys, 'Both paths should return same field set');

      // Same values for key fields
      assert.equal(solrR.id, sqliteR.id);
      assert.equal(solrR.toolName, sqliteR.toolName);
      assert.equal(solrR.note, sqliteR.note);
      assert.equal(solrR.outputLength, sqliteR.outputLength);
      assert.equal(solrR.content_preview, sqliteR.content_preview);
      assert.equal(solrR.content_start, sqliteR.content_start);
      assert.equal(solrR.content_end, sqliteR.content_end);
      assert.equal(solrR.content_lines, sqliteR.content_lines);
    });

    it('Solr results preserve order from Solr response', async () => {
      let agent = await createAgent('test-edge-order');
      let { key: key1 } = await createToolLogEntry(agent.id, { output: 'first' });
      let { key: key2 } = await createToolLogEntry(agent.id, { output: 'second' });
      let { key: key3 } = await createToolLogEntry(agent.id, { output: 'third' });

      // Return in specific order from Solr
      let mockSolr = createMockSolrService([ key3, key1, key2 ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 3);
      assert.equal(results[0].id, key3);
      assert.equal(results[1].id, key1);
      assert.equal(results[2].id, key2);
    });

    it('corrupted value JSON in DB returns empty preview (Solr path)', async () => {
      let agent = await createAgent('test-edge-corrupted-solr');
      let { ValueStore } = models;

      let entryKey = `tl_corrupted_solr_${Date.now()}`;
      await ValueStore.create({
        organizationID: organization.id,
        ownerType:      'agent',
        ownerID:        agent.id,
        namespace:      'tool_log',
        scopeID:        '',
        key:            entryKey,
        value:          '{not valid json!!!',
        note:           'bad entry',
        type:           'tool_log:test:broken',
      });

      let mockSolr = createMockSolrService([ entryKey ]);
      let tool     = instantiateTool(mockSolr);
      let results  = await tool.execute({ agentID: agent.id });

      assert.equal(results.length, 1);
      assert.equal(results[0].content_preview, '');
      assert.equal(results[0].outputLength, 0);
    });

    it('ownerID filter is sent to Solr as authorID fq', async () => {
      let agent = await createAgent('test-edge-ownerid');
      await createToolLogEntry(agent.id, { output: 'x' });

      let mockSolr = createMockSolrService([]);
      let tool     = instantiateTool(mockSolr);
      await tool.execute({ agentID: agent.id });

      let call = mockSolr.search.mock.calls[0];
      let fqs  = call.arguments[1].filterQueries;

      assert.ok(
        fqs.some((fq) => fq === `authorID:${agent.id}`),
        `Expected authorID fq, got: ${JSON.stringify(fqs)}`,
      );
    });
  });
});
