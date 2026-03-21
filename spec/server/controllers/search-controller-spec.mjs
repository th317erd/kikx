'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SearchController } from '../../../src/server/controllers/search-controller.mjs';
import { SolrError }       from '../../../src/core/lib/solr-service.mjs';

// =============================================================================
// SearchController Tests
// =============================================================================
// POST /api/v2/search         → search()
// POST /api/v2/sessions/:id/search → sessionSearch()
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSolrResponse(docs = [], numFound = null) {
  return {
    response: {
      numFound: (numFound != null) ? numFound : docs.length,
      docs,
    },
  };
}

function makeFrame({ id, sessionID, type, authorType, content, createdAt } = {}) {
  return {
    id:        id || 'frm_001',
    sessionID: sessionID || 'ses_001',
    type:      type || 'message',
    authorType: authorType || 'user',
    createdAt: createdAt || '2025-06-01T00:00:00.000Z',
    getContent() {
      if (!content)
        return null;

      if (typeof content === 'object')
        return content;

      return content;
    },
  };
}

function makeValueStore({ id, sessionID, type, ownerType, value, createdAt } = {}) {
  return {
    id:        id || 'vs_001',
    scopeID:   sessionID || 'ses_001',
    type:      type || 'context',
    ownerType: ownerType || 'agent',
    createdAt: createdAt || '2025-06-01T00:00:00.000Z',
    value:     value || 'some stored value',
  };
}

function buildController(overrides = {}) {
  let controller = Object.create(SearchController.prototype);

  // Mock route for throwBadRequestError
  controller.route = null;

  let mockSolrService = overrides.solrService || {
    search: async () => makeSolrResponse(),
  };

  let mockFrame = overrides.Frame || {
    where: {
      id: {
        EQ: () => ({
          first: async () => null,
        }),
      },
    },
  };

  let mockValueStore = overrides.ValueStore || {
    where: {
      id: {
        EQ: () => ({
          first: async () => null,
        }),
      },
    },
  };

  controller.getSolrService = () => mockSolrService;
  controller.getCoreModels  = () => ({
    Frame:      mockFrame,
    ValueStore: mockValueStore,
  });

  controller.request = { organizationID: 'org_test', userID: 'usr_test' };
  controller.responseStatusCode = 200;

  controller.setStatusCode = (code) => {
    controller.responseStatusCode = code;
  };

  controller.throwBadRequestError = (message) => {
    let error = new Error(message);
    error.statusCode = 400;
    throw error;
  };

  controller.throwNotFoundError = (message) => {
    let error = new Error(message);
    error.statusCode = 404;
    throw error;
  };

  return controller;
}

function makeEQChain(records) {
  return {
    where: {
      id: {
        EQ: (id) => ({
          first: async () => records.find((r) => r.id === id) || null,
        }),
      },
    },
  };
}

// =============================================================================
// Happy Paths
// =============================================================================

describe('SearchController: happy paths', () => {
  it('basic search returns correct response shape', async () => {
    let solrDocs = [
      { id: 'frm_001', doc_type: 'frame' },
    ];

    let frame = makeFrame({ id: 'frm_001', content: 'Hello world' });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse(solrDocs) },
      Frame:       makeEQChain([ frame ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'hello' } });

    assert.ok(result.data, 'response should have data');
    assert.equal(result.data.query, 'hello');
    assert.equal(typeof result.data.resultCount, 'number');
    assert.ok(result.data.pagination, 'should have pagination');
    assert.ok(Array.isArray(result.data.results), 'results should be an array');
  });

  it('results include enriched content from DB (frame)', async () => {
    let frame = makeFrame({
      id: 'frm_001',
      sessionID: 'ses_001',
      type: 'message',
      authorType: 'user',
      content: 'Hello from the database',
      createdAt: '2025-06-01T12:00:00.000Z',
    });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([ { id: 'frm_001', doc_type: 'frame' } ]) },
      Frame:       makeEQChain([ frame ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'hello' } });

    assert.equal(result.data.results.length, 1);
    let r = result.data.results[0];
    assert.equal(r.id, 'frm_001');
    assert.equal(r.doc_type, 'frame');
    assert.equal(r.type, 'message');
    assert.equal(r.sessionID, 'ses_001');
    assert.equal(r.authorType, 'user');
    assert.ok(r.preview, 'should have preview');
    assert.ok(typeof r.contentSize === 'number', 'contentSize should be a number');
  });

  it('results include enriched content from DB (value_store)', async () => {
    let vs = makeValueStore({
      id: 'vs_001',
      sessionID: 'ses_002',
      type: 'context',
      ownerType: 'agent',
      value: 'Stored context data',
    });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([ { id: 'vs_001', doc_type: 'value_store' } ]) },
      ValueStore:  makeEQChain([ vs ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'context' } });

    assert.equal(result.data.results.length, 1);
    let r = result.data.results[0];
    assert.equal(r.id, 'vs_001');
    assert.equal(r.doc_type, 'value_store');
    assert.equal(r.type, 'context');
    assert.equal(r.sessionID, 'ses_002');
    assert.equal(r.authorType, 'agent');
    assert.equal(r.preview, 'Stored context data');
  });

  it('contentRange null when content < 1024 chars', async () => {
    let frame = makeFrame({ id: 'frm_001', content: 'Short content' });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([ { id: 'frm_001', doc_type: 'frame' } ]) },
      Frame:       makeEQChain([ frame ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'short' } });
    assert.equal(result.data.results[0].contentRange, null);
  });

  it('contentRange [0, 1024] when content > 1024 chars', async () => {
    let longContent = 'x'.repeat(2000);
    let frame = makeFrame({ id: 'frm_001', content: longContent });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([ { id: 'frm_001', doc_type: 'frame' } ]) },
      Frame:       makeEQChain([ frame ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'x' } });
    let r = result.data.results[0];
    assert.deepEqual(r.contentRange, [ 0, 1024 ]);
    assert.equal(r.preview.length, 1024);
    assert.ok(r.contentSize > 1024, 'contentSize should reflect original length');
  });

  it('pagination matches Solr response', async () => {
    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([], 42) },
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test', rows: 5, start: 10 } });

    assert.equal(result.data.pagination.rows, 5);
    assert.equal(result.data.pagination.start, 10);
    assert.equal(result.data.pagination.total, 42);
    assert.equal(result.data.resultCount, 42);
  });

  it('sessionIDs filter applied correctly', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({
      params: {},
      query:  {},
      body:   { q: 'test', sessionIDs: [ 'ses_001', 'ses_002' ] },
    });

    assert.ok(capturedOptions.filterQueries, 'should have filterQueries');
    let sessionFilter = capturedOptions.filterQueries.find((fq) => fq.includes('sessionID'));
    assert.ok(sessionFilter, 'should have sessionID filter');
    assert.ok(sessionFilter.includes('ses_001'), 'should include first sessionID');
    assert.ok(sessionFilter.includes('ses_002'), 'should include second sessionID');
  });

  it('includeArchived removes archive filter', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({
      params: {},
      query:  {},
      body:   { q: 'test', includeArchived: true },
    });

    let archiveFilter = (capturedOptions.filterQueries || []).find((fq) => fq.includes('archived'));
    assert.equal(archiveFilter, undefined, 'should not have archive filter when includeArchived is true');
  });

  it('archive filter present by default', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({
      params: {},
      query:  {},
      body:   { q: 'test' },
    });

    let archiveFilter = (capturedOptions.filterQueries || []).find((fq) => fq.includes('archived'));
    assert.ok(archiveFilter, 'should have archive filter by default');
  });

  it('session-scoped search works', async () => {
    let capturedOptions;
    let frame = makeFrame({ id: 'frm_001', content: 'hello' });

    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse([ { id: 'frm_001', doc_type: 'frame' } ]);
        },
      },
      Frame: makeEQChain([ frame ]),
    });

    let result = await controller.sessionSearch({
      params: { sessionID: 'ses_999' },
      query:  {},
      body:   { q: 'hello' },
    });

    assert.ok(result.data, 'should return data');
    let sessionFilter = capturedOptions.filterQueries.find((fq) => fq.includes('sessionID'));
    assert.ok(sessionFilter, 'should have sessionID filter');
    assert.ok(sessionFilter.includes('ses_999'), 'should filter to the URL sessionID');
  });
});

// =============================================================================
// Input Validation (sad paths)
// =============================================================================

describe('SearchController: input validation', () => {
  it('missing q → 400', async () => {
    let controller = buildController();

    await assert.rejects(
      () => controller.search({ params: {}, query: {}, body: {} }),
      (error) => error.statusCode === 400 && error.message.includes('q'),
    );
  });

  it('empty string q → 400', async () => {
    let controller = buildController();

    await assert.rejects(
      () => controller.search({ params: {}, query: {}, body: { q: '' } }),
      (error) => error.statusCode === 400 && error.message.includes('q'),
    );
  });

  it('q is a number → 400', async () => {
    let controller = buildController();

    await assert.rejects(
      () => controller.search({ params: {}, query: {}, body: { q: 42 } }),
      (error) => error.statusCode === 400,
    );
  });

  it('q is an object → 400', async () => {
    let controller = buildController();

    await assert.rejects(
      () => controller.search({ params: {}, query: {}, body: { q: { nested: true } } }),
      (error) => error.statusCode === 400,
    );
  });

  it('q is null → 400', async () => {
    let controller = buildController();

    await assert.rejects(
      () => controller.search({ params: {}, query: {}, body: { q: null } }),
      (error) => error.statusCode === 400,
    );
  });

  it('rows > 100 → capped at 100', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test', rows: 500 } });
    assert.equal(capturedOptions.rows, 100);
  });

  it('rows < 1 → uses default 10', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test', rows: 0 } });
    assert.equal(capturedOptions.rows, 10);
  });

  it('negative rows → uses default 10', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test', rows: -5 } });
    assert.equal(capturedOptions.rows, 10);
  });

  it('start < 0 → uses 0', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test', start: -10 } });
    assert.equal(capturedOptions.start, 0);
  });
});

// =============================================================================
// Solr Failures
// =============================================================================

describe('SearchController: Solr failures', () => {
  it('Solr unavailable (connection refused) → 503', async () => {
    let controller = buildController({
      solrService: {
        search: async () => { throw new SolrError('Solr connection failed: ECONNREFUSED', 0, null); },
      },
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(controller.responseStatusCode, 503);
    assert.ok(result.error, 'should have error object');
    assert.ok(result.error.message.includes('unavailable'), 'should indicate unavailability');
  });

  it('Solr timeout → 503', async () => {
    let controller = buildController({
      solrService: {
        search: async () => { throw new SolrError('Solr request timed out after 15000ms', 408, null); },
      },
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(controller.responseStatusCode, 503);
    assert.ok(result.error.message.includes('unavailable'));
  });

  it('Solr returns error status → 500', async () => {
    let controller = buildController({
      solrService: {
        search: async () => { throw new SolrError('Solr HTTP 500', 500, null); },
      },
    });

    // Non-connection/timeout SolrErrors → re-throw or 500
    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(controller.responseStatusCode, 500);
    assert.ok(result.error, 'should have error');
  });
});

// =============================================================================
// DB Enrichment Failures
// =============================================================================

describe('SearchController: DB enrichment failures', () => {
  it('Frame ID from Solr not found in DB → result excluded', async () => {
    let controller = buildController({
      solrService: {
        search: async () => makeSolrResponse([ { id: 'frm_gone', doc_type: 'frame' } ]),
      },
      // Default Frame mock returns null for any ID
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(result.data.results.length, 0, 'missing frame should be excluded');
  });

  it('ValueStore ID not found in DB → result excluded', async () => {
    let controller = buildController({
      solrService: {
        search: async () => makeSolrResponse([ { id: 'vs_gone', doc_type: 'value_store' } ]),
      },
      // Default ValueStore mock returns null for any ID
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(result.data.results.length, 0, 'missing value_store should be excluded');
  });

  it('partial DB failure (3 of 5 fail) → return the 2 that succeeded', async () => {
    let frames = [
      makeFrame({ id: 'frm_001', content: 'a' }),
      makeFrame({ id: 'frm_003', content: 'c' }),
    ];

    let solrDocs = [
      { id: 'frm_001', doc_type: 'frame' },
      { id: 'frm_002', doc_type: 'frame' },
      { id: 'frm_003', doc_type: 'frame' },
      { id: 'frm_004', doc_type: 'frame' },
      { id: 'frm_005', doc_type: 'frame' },
    ];

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse(solrDocs, 5) },
      Frame:       makeEQChain(frames),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(result.data.results.length, 2, 'should return only the found records');
    assert.equal(result.data.resultCount, 5, 'resultCount should still reflect Solr total');
  });

  it('DB throws error during enrichment → skip failed record, not crash', async () => {
    let callCount = 0;

    let controller = buildController({
      solrService: {
        search: async () => makeSolrResponse([
          { id: 'frm_ok', doc_type: 'frame' },
          { id: 'frm_err', doc_type: 'frame' },
        ]),
      },
      Frame: {
        where: {
          id: {
            EQ: (id) => ({
              first: async () => {
                callCount++;
                if (id === 'frm_err')
                  throw new Error('DB connection lost');

                return makeFrame({ id, content: 'ok' });
              },
            }),
          },
        },
      },
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(result.data.results.length, 1, 'should have 1 successful result');
    assert.equal(result.data.results[0].id, 'frm_ok');
  });

  it('unknown doc_type from Solr → result excluded', async () => {
    let controller = buildController({
      solrService: {
        search: async () => makeSolrResponse([ { id: 'unk_001', doc_type: 'unknown_type' } ]),
      },
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(result.data.results.length, 0, 'unknown doc_type should be excluded');
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('SearchController: edge cases', () => {
  it('Solr returns 0 results → valid empty response', async () => {
    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([], 0) },
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'nonexistent' } });
    assert.equal(result.data.resultCount, 0);
    assert.deepEqual(result.data.results, []);
    assert.equal(result.data.pagination.total, 0);
  });

  it('sessionIDs as empty array → search all (no session filter)', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test', sessionIDs: [] } });

    let sessionFilter = (capturedOptions.filterQueries || []).find((fq) => fq.includes('sessionID'));
    assert.equal(sessionFilter, undefined, 'empty sessionIDs should not add session filter');
  });

  it('very large contentSize → preview truncated correctly', async () => {
    let hugeContent = 'A'.repeat(50000);
    let frame = makeFrame({ id: 'frm_huge', content: hugeContent });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([ { id: 'frm_huge', doc_type: 'frame' } ]) },
      Frame:       makeEQChain([ frame ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'A' } });
    let r = result.data.results[0];
    assert.equal(r.preview.length, 1024);
    assert.equal(r.contentSize, 50000);
    assert.deepEqual(r.contentRange, [ 0, 1024 ]);
  });

  it('frame with null content → excluded or has empty preview', async () => {
    let frame = makeFrame({ id: 'frm_null', content: null });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([ { id: 'frm_null', doc_type: 'frame' } ]) },
      Frame:       makeEQChain([ frame ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    // Null content: either excluded or has empty preview
    if (result.data.results.length === 1) {
      assert.equal(result.data.results[0].preview, '');
      assert.equal(result.data.results[0].contentSize, 0);
    } else {
      assert.equal(result.data.results.length, 0);
    }
  });

  it('frame with object content → preview is JSON string', async () => {
    let objContent = { text: 'Hello', html: '<p>Hello</p>' };
    let frame = makeFrame({ id: 'frm_obj', content: objContent });

    let controller = buildController({
      solrService: { search: async () => makeSolrResponse([ { id: 'frm_obj', doc_type: 'frame' } ]) },
      Frame:       makeEQChain([ frame ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'hello' } });
    assert.equal(result.data.results.length, 1);
    let r = result.data.results[0];
    // Object content: extract text or html field, or stringify
    assert.ok(typeof r.preview === 'string', 'preview should be a string');
    assert.ok(r.contentSize > 0, 'contentSize should be positive');
  });

  it('defType edismax is passed to Solr', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(capturedOptions.defType, 'edismax');
  });

  it('highlight option forwarded to Solr', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({
      params: {},
      query:  {},
      body:   { q: 'test', highlight: true },
    });

    assert.ok(capturedOptions.highlight, 'highlight should be forwarded');
  });

  it('mixed doc_types in results', async () => {
    let frame = makeFrame({ id: 'frm_mix', content: 'frame content' });
    let vs    = makeValueStore({ id: 'vs_mix', value: 'value content' });

    let controller = buildController({
      solrService: {
        search: async () => makeSolrResponse([
          { id: 'frm_mix', doc_type: 'frame' },
          { id: 'vs_mix', doc_type: 'value_store' },
        ]),
      },
      Frame:      makeEQChain([ frame ]),
      ValueStore: makeEQChain([ vs ]),
    });

    let result = await controller.search({ params: {}, query: {}, body: { q: 'content' } });
    assert.equal(result.data.results.length, 2);
    assert.equal(result.data.results[0].doc_type, 'frame');
    assert.equal(result.data.results[1].doc_type, 'value_store');
  });

  it('sessionSearch with missing q → 400', async () => {
    let controller = buildController();

    await assert.rejects(
      () => controller.sessionSearch({ params: { sessionID: 'ses_001' }, query: {}, body: {} }),
      (error) => error.statusCode === 400,
    );
  });

  it('sessionSearch merges sessionID from params, ignoring body sessionIDs', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.sessionSearch({
      params: { sessionID: 'ses_from_url' },
      query:  {},
      body:   { q: 'test', sessionIDs: [ 'ses_ignored' ] },
    });

    let sessionFilter = capturedOptions.filterQueries.find((fq) => fq.includes('sessionID'));
    assert.ok(sessionFilter.includes('ses_from_url'), 'should use URL sessionID');
    assert.ok(!sessionFilter.includes('ses_ignored'), 'should not use body sessionIDs');
  });

  it('default rows is 10', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(capturedOptions.rows, 10);
  });

  it('default start is 0', async () => {
    let capturedOptions;
    let controller = buildController({
      solrService: {
        search: async (_q, opts) => {
          capturedOptions = opts;
          return makeSolrResponse();
        },
      },
    });

    await controller.search({ params: {}, query: {}, body: { q: 'test' } });
    assert.equal(capturedOptions.start, 0);
  });
});
