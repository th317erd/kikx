'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PluginInterface } from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }  from '../../../src/core/plugin-loader/registry.mjs';
import { setup }           from '../../../src/core/internal-plugins/search/index.mjs';

// =============================================================================
// search:query Agent Tool — Unit Tests
// =============================================================================
// Pure unit tests with mocked SolrService and models.
// No real DB or Solr needed.
// =============================================================================

describe('Search Plugin — search:query', () => {
  let SearchQueryTool;
  let mockSolrService;
  let mockFrame;
  let mockValueStore;

  // ---------------------------------------------------------------------------
  // Mock helpers
  // ---------------------------------------------------------------------------

  function createMockSolrService(overrides = {}) {
    return {
      search: overrides.search || (async () => ({
        response: { numFound: 0, docs: [] },
      })),
    };
  }

  function createMockModel(records = {}) {
    return {
      where: new Proxy({}, {
        get(_target, field) {
          return {
            EQ: (value) => ({
              first: async () => records[value] || null,
            }),
          };
        },
      }),
    };
  }

  function createContext({ solrService, models } = {}) {
    return {
      getProperty: (name) => {
        if (name === 'solrService') return solrService || null;
        if (name === 'models') return models || { Frame: createMockModel(), ValueStore: createMockModel() };
        return null;
      },
    };
  }

  function instantiate(context) {
    return new SearchQueryTool(context);
  }

  // ---------------------------------------------------------------------------
  // Setup — register plugin once
  // ---------------------------------------------------------------------------

  beforeEach(() => {
    let registry = new PluginRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });
    setup((cb) => cb({ registry, context: null }));
    SearchQueryTool = registry.getTool('search:query');
    assert.ok(SearchQueryTool, 'search:query tool should be registered');
  });

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('registration', () => {
    it('registers search:query tool', () => {
      assert.ok(SearchQueryTool);
      assert.equal(SearchQueryTool.pluginID, 'search');
      assert.equal(SearchQueryTool.featureName, 'query');
      assert.equal(SearchQueryTool.displayName, 'Search');
    });

    it('extends PluginInterface', () => {
      let tool = instantiate(createContext({ solrService: createMockSolrService() }));
      assert.ok(tool instanceof PluginInterface);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe('happy paths', () => {
    it('basic query returns correct response shape', async () => {
      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'frame-1', doc_type: 'frame' }],
          },
        }),
      });

      let frameRecord = {
        id: 'frame-1', type: 'message', sessionID: 'sess-1',
        getContent: () => ({ text: 'Hello world' }),
        content: 'Hello world',
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({ 'frame-1': frameRecord }),
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'hello' });

      assert.equal(result.query, 'hello');
      assert.equal(result.resultCount, 1);
      assert.ok(Array.isArray(result.results));
      assert.equal(result.results.length, 1);
      assert.ok(typeof result.message === 'string');
    });

    it('results include enriched content with preview', async () => {
      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'frame-1', doc_type: 'frame' }],
          },
        }),
      });

      let frameRecord = {
        id: 'frame-1', type: 'message', sessionID: 'sess-1',
        getContent: () => ({ text: 'Hello world preview content' }),
        content: 'Hello world preview content',
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({ 'frame-1': frameRecord }),
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'hello' });

      let r = result.results[0];
      assert.equal(r.id, 'frame-1');
      assert.equal(r.doc_type, 'frame');
      assert.equal(r.type, 'message');
      assert.equal(r.sessionID, 'sess-1');
      assert.equal(r.preview, 'Hello world preview content');
      assert.equal(r.contentSize, 27);
      assert.equal(r.contentRange, null);
    });

    it('content > 1024 chars produces contentRange [0, 1024]', async () => {
      let longContent = 'x'.repeat(2000);

      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'frame-1', doc_type: 'frame' }],
          },
        }),
      });

      let frameRecord = {
        id: 'frame-1', type: 'message', sessionID: 'sess-1',
        getContent: () => ({ text: longContent }),
        content: longContent,
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({ 'frame-1': frameRecord }),
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'test' });
      let r      = result.results[0];

      assert.equal(r.preview.length, 1024);
      assert.deepEqual(r.contentRange, [0, 1024]);
      assert.equal(r.contentSize, 2000);
    });

    it('content <= 1024 chars produces contentRange null', async () => {
      let shortContent = 'x'.repeat(500);

      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'frame-1', doc_type: 'frame' }],
          },
        }),
      });

      let frameRecord = {
        id: 'frame-1', type: 'message', sessionID: 'sess-1',
        getContent: () => ({ text: shortContent }),
        content: shortContent,
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({ 'frame-1': frameRecord }),
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'test' });

      assert.equal(result.results[0].contentRange, null);
    });

    it('chunk-fetch hint in message when results are truncated', async () => {
      let longContent = 'x'.repeat(2000);

      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'frame-1', doc_type: 'frame' }],
          },
        }),
      });

      let frameRecord = {
        id: 'frame-1', type: 'message', sessionID: 'sess-1',
        getContent: () => ({ text: longContent }),
        content: longContent,
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({ 'frame-1': frameRecord }),
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'test' });

      assert.ok(result.message.includes('truncated'));
      assert.ok(result.message.includes('tool_log:get'));
    });

    it('docType filter applied as fq', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test', docType: 'frame' });

      assert.equal(searchCalls.length, 1);
      let fq = searchCalls[0].options.filterQueries;
      assert.ok(fq.some(f => f === 'doc_type:frame'));
    });

    it('frameType filter applied as fq', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test', frameType: 'tool-call' });

      assert.equal(searchCalls.length, 1);
      let fq = searchCalls[0].options.filterQueries;
      assert.ok(fq.some(f => f === 'type:tool-call'));
    });

    it('default sessionID from _sessionID', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test', _sessionID: 'sess-current' });

      let fq = searchCalls[0].options.filterQueries;
      assert.ok(fq.some(f => f === 'sessionID:sess-current'));
    });

    it('enriches ValueStore records correctly', async () => {
      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'vs-1', doc_type: 'value_store' }],
          },
        }),
      });

      let vsRecord = {
        id: 'vs-1', type: 'tool_log:shell:execute', scopeID: 'sess-1',
        value: 'npm install output here',
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel(),
          ValueStore: createMockModel({ 'vs-1': vsRecord }),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'npm' });

      let r = result.results[0];
      assert.equal(r.id, 'vs-1');
      assert.equal(r.doc_type, 'value_store');
      assert.equal(r.sessionID, 'sess-1');
      assert.equal(r.preview, 'npm install output here');
    });
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  describe('input validation', () => {
    it('missing query throws Error', async () => {
      let context = createContext({ solrService: createMockSolrService() });
      let tool    = instantiate(context);

      await assert.rejects(
        () => tool.execute({}),
        { message: /query is required/ },
      );
    });

    it('query not a string throws Error', async () => {
      let context = createContext({ solrService: createMockSolrService() });
      let tool    = instantiate(context);

      await assert.rejects(
        () => tool.execute({ query: 123 }),
        { message: /query is required and must be a string/ },
      );
    });

    it('rows > 50 capped at 50', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test', rows: 100 });

      assert.equal(searchCalls[0].options.rows, 50);
    });

    it('rows < 1 uses default 10', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test', rows: 0 });

      // rows < 1 → Math.max(parseInt(0, 10) || 10, 1) → Math.max(10, 1) → 10
      // Actually: parseInt(0, 10) = 0, 0 || 10 = 10, Math.max(10, 1) = 10
      assert.equal(searchCalls[0].options.rows, 10);
    });

    it('rows is NaN uses default 10', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test', rows: 'banana' });

      assert.equal(searchCalls[0].options.rows, 10);
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {
    it('SolrService not on context throws descriptive error', async () => {
      let context = createContext({ solrService: null });
      let tool    = instantiate(context);

      await assert.rejects(
        () => tool.execute({ query: 'test' }),
        { message: /Solr service is unavailable/ },
      );
    });

    it('SolrService.search() throws → error propagates', async () => {
      let solrService = createMockSolrService({
        search: async () => { throw new Error('Solr connection refused'); },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);

      await assert.rejects(
        () => tool.execute({ query: 'test' }),
        { message: /Solr connection refused/ },
      );
    });

    it('all result IDs missing from DB → empty results, resultCount shows Solr count', async () => {
      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 3,
            docs: [
              { id: 'gone-1', doc_type: 'frame' },
              { id: 'gone-2', doc_type: 'frame' },
              { id: 'gone-3', doc_type: 'value_store' },
            ],
          },
        }),
      });

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({}),
          ValueStore: createMockModel({}),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'lost' });

      assert.equal(result.resultCount, 3);
      assert.equal(result.results.length, 0);
    });

    it('partial DB failures → returns successful ones only', async () => {
      let callCount = 0;
      let failingFrame = {
        where: new Proxy({}, {
          get() {
            return {
              EQ: () => ({
                first: async () => {
                  callCount++;
                  if (callCount === 1) throw new Error('DB error');
                  return {
                    id: 'frame-2', type: 'message', sessionID: 'sess-1',
                    getContent: () => ({ text: 'good result' }),
                    content: 'good result',
                  };
                },
              }),
            };
          },
        }),
      };

      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 2,
            docs: [
              { id: 'frame-1', doc_type: 'frame' },
              { id: 'frame-2', doc_type: 'frame' },
            ],
          },
        }),
      });

      let context = createContext({
        solrService,
        models: {
          Frame:      failingFrame,
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'test' });

      assert.equal(result.resultCount, 2);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].id, 'frame-2');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('sessionID param overrides _sessionID', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test', sessionID: 'explicit-sess', _sessionID: 'current-sess' });

      let fq = searchCalls[0].options.filterQueries;
      assert.ok(fq.some(f => f === 'sessionID:explicit-sess'));
      assert.ok(!fq.some(f => f.includes('current-sess')));
    });

    it('no sessionID and no _sessionID → no session filter', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test' });

      let fq = searchCalls[0].options.filterQueries;
      assert.ok(!fq.some(f => f.startsWith('sessionID:')));
    });

    it('Solr returns 0 results → valid empty response', async () => {
      let solrService = createMockSolrService({
        search: async () => ({
          response: { numFound: 0, docs: [] },
        }),
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      let result  = await tool.execute({ query: 'nothing' });

      assert.equal(result.resultCount, 0);
      assert.deepEqual(result.results, []);
      assert.ok(result.message.includes('Found 0 results'));
    });

    it('content that is not a string gets JSON.stringified', async () => {
      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'frame-1', doc_type: 'frame' }],
          },
        }),
      });

      let frameRecord = {
        id: 'frame-1', type: 'message', sessionID: 'sess-1',
        getContent: () => ({ text: { nested: 'object' } }),
        content: { nested: 'object' },
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({ 'frame-1': frameRecord }),
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'test' });

      assert.equal(result.results[0].preview, '{"nested":"object"}');
    });

    it('frame without getContent falls back to .content string', async () => {
      let solrService = createMockSolrService({
        search: async () => ({
          response: {
            numFound: 1,
            docs: [{ id: 'frame-1', doc_type: 'frame' }],
          },
        }),
      });

      let frameRecord = {
        id: 'frame-1', type: 'message', sessionID: 'sess-1',
        content: 'fallback content string',
      };

      let context = createContext({
        solrService,
        models: {
          Frame:      createMockModel({ 'frame-1': frameRecord }),
          ValueStore: createMockModel(),
        },
      });

      let tool   = instantiate(context);
      let result = await tool.execute({ query: 'test' });

      assert.equal(result.results[0].preview, 'fallback content string');
    });

    it('passes fields: [id, doc_type] to SolrService.search()', async () => {
      let searchCalls = [];
      let solrService = createMockSolrService({
        search: async (query, options) => {
          searchCalls.push({ query, options });
          return { response: { numFound: 0, docs: [] } };
        },
      });

      let context = createContext({ solrService });
      let tool    = instantiate(context);
      await tool.execute({ query: 'test' });

      assert.deepEqual(searchCalls[0].options.fields, ['id', 'doc_type']);
    });

    it('getHelp() returns schema and examples', () => {
      let context = createContext({ solrService: createMockSolrService() });
      let tool    = instantiate(context);
      let help    = tool.getHelp();

      assert.equal(help.name, 'search:query');
      assert.equal(help.displayName, 'Search');
      assert.ok(help.inputSchema);
      assert.ok(help.usage);
      assert.ok(Array.isArray(help.examples));
    });
  });
});
