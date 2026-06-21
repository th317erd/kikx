'use strict';

import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  SolrService,
  SolrError,
  RETRYABLE_STATUS_CODES,
} from '../../../src/core/lib/solr-service.mjs';

// =============================================================================
// SolrService Tests
// =============================================================================
// Mocks globalThis.fetch to test all code paths without a running Solr instance.
// Covers: construction, URL building, request handling, all public methods,
// error paths, timeouts, batch operations, and cursor streaming.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function solrOkResponse(extra = {}) {
  return jsonResponse({
    responseHeader: { status: 0, QTime: 1 },
    ...extra,
  });
}

function solrSearchResponse(docs, numFound, extra = {}) {
  return jsonResponse({
    responseHeader: { status: 0, QTime: 5 },
    response: {
      numFound: (numFound != null) ? numFound : docs.length,
      start:    0,
      docs,
    },
    ...extra,
  });
}

function solrErrorResponse(message, status = 400) {
  return jsonResponse({
    responseHeader: { status },
    error: { msg: message, code: status },
  }, status);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SolrService', () => {
  let service;
  let originalFetch;
  let fetchMock;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    service   = new SolrService({ host: 'http://localhost:8983', core: 'kikx' });
    fetchMock = mock.fn(() => solrOkResponse());
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    mock.restoreAll();
  });

  // ---------------------------------------------------------------------------
  // Constructor & Accessors
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('uses default values when no options provided', () => {
      let defaultService = new SolrService();
      assert.equal(defaultService.getHost(), 'http://localhost:8983');
      assert.equal(defaultService.getCore(), 'kikx');
      assert.equal(defaultService.getTimeout(), 15000);
    });

    it('accepts custom host, core, and timeout', () => {
      let custom = new SolrService({ host: 'http://solr:9999', core: 'mycore', timeout: 5000 });
      assert.equal(custom.getHost(), 'http://solr:9999');
      assert.equal(custom.getCore(), 'mycore');
      assert.equal(custom.getTimeout(), 5000);
    });

    it('accepts a context parameter', () => {
      let fakeContext = { getProperty: () => null };
      let withContext = new SolrService({ context: fakeContext });
      assert.equal(withContext._context, fakeContext);
    });
  });

  // ---------------------------------------------------------------------------
  // SolrError
  // ---------------------------------------------------------------------------

  describe('SolrError', () => {
    it('has correct name, status, and body', () => {
      let error = new SolrError('something broke', 500, { detail: 'info' });
      assert.equal(error.name, 'SolrError');
      assert.equal(error.message, 'something broke');
      assert.equal(error.status, 500);
      assert.deepEqual(error.body, { detail: 'info' });
    });

    it('isRetryable returns true for 408, 429, 503, 504', () => {
      for (let code of [408, 429, 503, 504])
        assert.equal(new SolrError('test', code, null).isRetryable(), true);
    });

    it('isRetryable returns false for non-retryable codes', () => {
      for (let code of [400, 401, 404, 500])
        assert.equal(new SolrError('test', code, null).isRetryable(), false);
    });

    it('is an instance of Error', () => {
      assert.ok(new SolrError('test', 0, null) instanceof Error);
    });
  });

  // ---------------------------------------------------------------------------
  // RETRYABLE_STATUS_CODES
  // ---------------------------------------------------------------------------

  describe('RETRYABLE_STATUS_CODES', () => {
    it('contains exactly 408, 429, 503, 504', () => {
      assert.deepEqual([ ...RETRYABLE_STATUS_CODES ].sort(), [ 408, 429, 503, 504 ]);
    });
  });

  // ---------------------------------------------------------------------------
  // _buildURL
  // ---------------------------------------------------------------------------

  describe('_buildURL', () => {
    it('builds a core-scoped URL with wt=json', () => {
      let url = service._buildURL('/select', {});
      assert.ok(url.startsWith('http://localhost:8983/solr/kikx/select'));
      assert.ok(url.includes('wt=json'));
    });

    it('includes scalar params', () => {
      let url = service._buildURL('/select', { q: 'hello', rows: 10 });
      assert.ok(url.includes('q=hello'));
      assert.ok(url.includes('rows=10'));
    });

    it('appends array params as multiple values', () => {
      let url = service._buildURL('/select', { fq: ['type:Message', 'hidden:false'] });
      let parsed = new URL(url);
      let fqValues = parsed.searchParams.getAll('fq');
      assert.deepEqual(fqValues, ['type:Message', 'hidden:false']);
    });

    it('skips null and undefined values', () => {
      let url = service._buildURL('/select', { q: 'test', fq: null, rows: undefined });
      assert.ok(url.includes('q=test'));
      assert.ok(!url.includes('fq'));
      assert.ok(!url.includes('rows'));
    });

    it('works with no params', () => {
      let url = service._buildURL('/select');
      assert.ok(url.includes('/solr/kikx/select'));
      assert.ok(url.includes('wt=json'));
    });
  });

  // ---------------------------------------------------------------------------
  // _buildAdminURL
  // ---------------------------------------------------------------------------

  describe('_buildAdminURL', () => {
    it('builds a non-core-scoped admin URL', () => {
      let url = service._buildAdminURL('/admin/cores', { action: 'STATUS', core: 'kikx' });
      assert.ok(url.startsWith('http://localhost:8983/solr/admin/cores'));
      assert.ok(url.includes('action=STATUS'));
      assert.ok(url.includes('core=kikx'));
      assert.ok(url.includes('wt=json'));
    });
  });

  // ---------------------------------------------------------------------------
  // _request — success paths
  // ---------------------------------------------------------------------------

  describe('_request', () => {
    it('makes a GET request and returns parsed JSON', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse({ custom: 'data' }));

      let result = await service._request('GET', '/admin/ping');
      assert.equal(result.responseHeader.status, 0);
      assert.equal(result.custom, 'data');
    });

    it('makes a POST request with JSON body', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service._request('POST', '/update', { body: { commit: {} } });

      let call = fetchMock.mock.calls[0];
      let fetchOptions = call.arguments[1];
      assert.equal(fetchOptions.method, 'POST');
      assert.equal(fetchOptions.headers['Content-Type'], 'application/json');
      assert.equal(fetchOptions.body, '{"commit":{}}');
    });

    it('passes AbortSignal.timeout on every request', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service._request('GET', '/select', { params: { q: '*:*' } });

      let call = fetchMock.mock.calls[0];
      let fetchOptions = call.arguments[1];
      assert.ok(fetchOptions.signal, 'signal should be set');
    });

    it('uses admin URL when admin flag is true', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service._request('GET', '/admin/cores', {
        params: { action: 'STATUS' },
        admin:  true,
      });

      let call = fetchMock.mock.calls[0];
      let url  = call.arguments[0];
      // Admin URL should NOT have /solr/kikx/ prefix — just /solr/
      assert.ok(url.includes('/solr/admin/cores'));
      assert.ok(!url.includes('/solr/kikx/admin/cores'));
    });
  });

  // ---------------------------------------------------------------------------
  // _request — error paths
  // ---------------------------------------------------------------------------

  describe('_request error handling', () => {
    it('throws SolrError with status 408 on timeout', async () => {
      fetchMock.mock.mockImplementation(() => {
        let error  = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      });

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.equal(error.status, 408);
          assert.ok(error.message.includes('timed out'));
          return true;
        },
      );
    });

    it('throws SolrError with status 408 on AbortError', async () => {
      fetchMock.mock.mockImplementation(() => {
        let error  = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      });

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.equal(error.status, 408);
          return true;
        },
      );
    });

    it('throws SolrError with status 0 on network failure', async () => {
      fetchMock.mock.mockImplementation(() => {
        throw new Error('ECONNREFUSED');
      });

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.equal(error.status, 0);
          assert.ok(error.message.includes('connection failed'));
          return true;
        },
      );
    });

    it('throws SolrError on non-JSON response', async () => {
      fetchMock.mock.mockImplementation(() => {
        return new Response('<html>Not Found</html>', {
          status:  200,
          headers: { 'Content-Type': 'text/html' },
        });
      });

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.ok(error.message.includes('non-JSON'));
          return true;
        },
      );
    });

    it('throws SolrError on HTTP error with Solr error message', async () => {
      fetchMock.mock.mockImplementation(() => solrErrorResponse('undefined field foobar', 400));

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.equal(error.status, 400);
          assert.ok(error.message.includes('undefined field foobar'));
          assert.ok(error.body);
          return true;
        },
      );
    });

    it('throws SolrError on HTTP error without Solr error message', async () => {
      fetchMock.mock.mockImplementation(() => jsonResponse({}, 500));

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.equal(error.status, 500);
          assert.ok(error.message.includes('Solr HTTP 500'));
          return true;
        },
      );
    });

    it('throws SolrError when Solr returns non-zero status in responseHeader', async () => {
      fetchMock.mock.mockImplementation(() => jsonResponse({
        responseHeader: { status: 42 },
        error:          { msg: 'bad query syntax' },
      }));

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.equal(error.status, 42);
          assert.ok(error.message.includes('bad query syntax'));
          return true;
        },
      );
    });

    it('throws SolrError when response body cannot be read', async () => {
      fetchMock.mock.mockImplementation(() => {
        return {
          ok:     true,
          status: 200,
          text:   () => { throw new Error('stream broken'); },
        };
      });

      await assert.rejects(
        () => service._request('GET', '/select'),
        (error) => {
          assert.ok(error instanceof SolrError);
          assert.ok(error.message.includes('Failed to read'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // ping
  // ---------------------------------------------------------------------------

  describe('ping', () => {
    it('returns true when Solr is healthy', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse({ status: 'OK' }));
      let result = await service.ping();
      assert.equal(result, true);
    });

    it('returns false when Solr is unreachable', async () => {
      fetchMock.mock.mockImplementation(() => { throw new Error('ECONNREFUSED'); });
      let result = await service.ping();
      assert.equal(result, false);
    });

    it('returns false when Solr returns an error', async () => {
      fetchMock.mock.mockImplementation(() => solrErrorResponse('core not found', 404));
      let result = await service.ping();
      assert.equal(result, false);
    });
  });

  // ---------------------------------------------------------------------------
  // getCoreStatus
  // ---------------------------------------------------------------------------

  describe('getCoreStatus', () => {
    it('calls admin/cores with STATUS action', async () => {
      let statusBody = {
        responseHeader: { status: 0 },
        status: { kikx: { name: 'kikx', uptime: 12345 } },
      };

      fetchMock.mock.mockImplementation(() => jsonResponse(statusBody));

      let result = await service.getCoreStatus();

      let call = fetchMock.mock.calls[0];
      let url  = call.arguments[0];
      assert.ok(url.includes('/solr/admin/cores'));
      assert.ok(url.includes('action=STATUS'));
      assert.ok(url.includes('core=kikx'));
      assert.equal(result.status.kikx.name, 'kikx');
    });
  });

  // ---------------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------------

  describe('search', () => {
    it('sends a basic search query with eDisMax', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([{ id: 'doc1' }], 1));

      let result = await service.search('hello world');

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('q'), 'hello world');
      assert.equal(url.searchParams.get('defType'), 'edismax');
      assert.equal(url.searchParams.get('rows'), '10');
      assert.equal(url.searchParams.get('start'), '0');
      assert.equal(result.response.docs.length, 1);
    });

    it('accepts custom rows, start, and sort', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('test', { rows: 25, start: 50, sort: 'timestamp desc' });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('rows'), '25');
      assert.equal(url.searchParams.get('start'), '50');
      assert.equal(url.searchParams.get('sort'), 'timestamp desc');
    });

    it('sends filter queries as fq params', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('*:*', {
        filterQueries: ['doc_type:frame', 'sessionID:ses_123'],
      });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      let fqValues = url.searchParams.getAll('fq');
      assert.deepEqual(fqValues, ['doc_type:frame', 'sessionID:ses_123']);
    });

    it('sends field list as fl param', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('*:*', { fields: ['id', 'content_text', 'timestamp'] });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('fl'), 'id,content_text,timestamp');
    });

    it('accepts fields as a comma-separated string', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('*:*', { fields: 'id,content_text' });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('fl'), 'id,content_text');
    });

    it('sends queryFields as qf param', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('hello', { queryFields: 'content_text^5 tool_output^2' });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('qf'), 'content_text^5 tool_output^2');
    });

    it('enables highlighting when highlight option is set', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('test', {
        highlight: { fields: 'content_text', pre: '<b>', post: '</b>' },
      });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('hl'), 'on');
      assert.equal(url.searchParams.get('hl.fl'), 'content_text');
      assert.equal(url.searchParams.get('hl.simple.pre'), '<b>');
      assert.equal(url.searchParams.get('hl.simple.post'), '</b>');
    });

    it('uses default highlight markers when not specified', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('test', { highlight: {} });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('hl.fl'), '_text_');
      assert.equal(url.searchParams.get('hl.simple.pre'), '<em>');
      assert.equal(url.searchParams.get('hl.simple.post'), '</em>');
    });

    it('uses cursorMark for cursor pagination', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('*:*', { cursorMark: '*' });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('cursorMark'), '*');
      assert.equal(url.searchParams.get('sort'), 'id asc');
      assert.equal(url.searchParams.get('start'), null);
    });

    it('does not override explicit sort with cursorMark default', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      await service.search('*:*', { cursorMark: '*', sort: 'timestamp desc, id asc' });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('sort'), 'timestamp desc, id asc');
    });
  });

  // ---------------------------------------------------------------------------
  // indexDocuments
  // ---------------------------------------------------------------------------

  describe('indexDocuments', () => {
    it('sends a single document as an array', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.indexDocuments({ id: 'doc1', content_text: 'hello' });

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(body[0].id, 'doc1');
    });

    it('sends multiple documents as a batch', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      let docs = [
        { id: 'doc1', content_text: 'hello' },
        { id: 'doc2', content_text: 'world' },
        { id: 'doc3', content_text: 'test' },
      ];

      await service.indexDocuments(docs);

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.equal(body.length, 3);
    });

    it('includes commitWithin param (default 1000ms)', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.indexDocuments({ id: 'doc1' });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('commitWithin'), '1000');
    });

    it('accepts custom commitWithin', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.indexDocuments({ id: 'doc1' }, { commitWithin: 5000 });

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('commitWithin'), '5000');
    });

    it('returns null for empty array without making a request', async () => {
      let result = await service.indexDocuments([]);
      assert.equal(result, null);
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteDocuments
  // ---------------------------------------------------------------------------

  describe('deleteDocuments', () => {
    it('sends a single ID for deletion', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.deleteDocuments('doc1');

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.deepEqual(body.delete, ['doc1']);
    });

    it('sends multiple IDs for deletion', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.deleteDocuments(['doc1', 'doc2', 'doc3']);

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.deepEqual(body.delete, ['doc1', 'doc2', 'doc3']);
    });

    it('includes commit block when commit option is true', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.deleteDocuments('doc1', { commit: true });

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.deepEqual(body.commit, {});
    });

    it('does not include commit block by default', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.deleteDocuments('doc1');

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.equal(body.commit, undefined);
    });

    it('returns null for empty array without making a request', async () => {
      let result = await service.deleteDocuments([]);
      assert.equal(result, null);
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteByQuery
  // ---------------------------------------------------------------------------

  describe('deleteByQuery', () => {
    it('sends a delete-by-query command', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.deleteByQuery('doc_type:frame AND sessionID:ses_123');

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.deepEqual(body.delete, { query: 'doc_type:frame AND sessionID:ses_123' });
    });

    it('includes commit block when commit option is true', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.deleteByQuery('*:*', { commit: true });

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.deepEqual(body.commit, {});
    });
  });

  // ---------------------------------------------------------------------------
  // commit
  // ---------------------------------------------------------------------------

  describe('commit', () => {
    it('sends a hard commit command', async () => {
      fetchMock.mock.mockImplementation(() => solrOkResponse());

      await service.commit();

      let call = fetchMock.mock.calls[0];
      let body = JSON.parse(call.arguments[1].body);
      assert.deepEqual(body, { commit: {} });
    });
  });

  // ---------------------------------------------------------------------------
  // stream (cursor-based pagination)
  // ---------------------------------------------------------------------------

  describe('stream', () => {
    it('yields all documents across multiple pages', async () => {
      let callCount = 0;

      fetchMock.mock.mockImplementation(() => {
        callCount++;

        if (callCount === 1) {
          return solrSearchResponse(
            [{ id: 'a' }, { id: 'b' }],
            5,
            { nextCursorMark: 'cursor_page2' },
          );
        }

        if (callCount === 2) {
          return solrSearchResponse(
            [{ id: 'c' }, { id: 'd' }],
            5,
            { nextCursorMark: 'cursor_page3' },
          );
        }

        // Last page — only 1 doc, cursor doesn't advance
        return solrSearchResponse(
          [{ id: 'e' }],
          5,
          { nextCursorMark: 'cursor_page3' },
        );
      });

      let collected = [];

      for await (let doc of service.stream('*:*', { rows: 2 }))
        collected.push(doc.id);

      assert.deepEqual(collected, ['a', 'b', 'c', 'd', 'e']);
      assert.equal(callCount, 3);
    });

    it('stops when Solr returns empty docs', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

      let collected = [];

      for await (let doc of service.stream('*:*'))
        collected.push(doc);

      assert.equal(collected.length, 0);
      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('stops when cursorMark does not advance', async () => {
      fetchMock.mock.mockImplementation(() => {
        return solrSearchResponse(
          [{ id: 'only' }],
          1,
          { nextCursorMark: '*' },
        );
      });

      let collected = [];

      for await (let doc of service.stream('*:*'))
        collected.push(doc.id);

      // Should yield the doc but not loop forever
      assert.deepEqual(collected, ['only']);
      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('uses default sort "id asc" and rows 500', async () => {
      fetchMock.mock.mockImplementation(() => solrSearchResponse([], 0));

       
      for await (let _doc of service.stream('*:*')) {
        // no-op
      }

      let call = fetchMock.mock.calls[0];
      let url  = new URL(call.arguments[0]);
      assert.equal(url.searchParams.get('sort'), 'id asc');
      assert.equal(url.searchParams.get('rows'), '500');
      assert.equal(url.searchParams.get('cursorMark'), '*');
    });

    it('propagates search errors', async () => {
      fetchMock.mock.mockImplementation(() => solrErrorResponse('bad query', 400));

      await assert.rejects(async () => {
         
        for await (let _doc of service.stream('invalid:::query')) {
          // no-op
        }
      }, (error) => {
        assert.ok(error instanceof SolrError);
        return true;
      });
    });
  });
});
