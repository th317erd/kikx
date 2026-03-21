'use strict';

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ValueStore } from '../../../src/core/models/value-store-model.mjs';
import { SolrError }  from '../../../src/core/lib/solr-service.mjs';

// =============================================================================
// ValueStore onAfterSave — Solr Indexing Tests
// =============================================================================
// Unit tests for the onAfterSave() lifecycle hook that indexes ValueStore
// records into Solr. Tests use mocked application/context/solrService to
// verify field mapping, error handling, and graceful degradation.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockInstance(fields = {}) {
  let defaults = {
    id:        'vs_abc123',
    type:      'tool_log:shell:execute',
    namespace: 'tool_log',
    scopeID:   'ses_xyz789',
    ownerType: 'Agent',
    ownerID:   'agt_test1',
    note:      'some note',
    value:     '{"result":"ok"}',
    createdAt: '2026-03-20T12:00:00.000Z',
  };

  let merged   = { ...defaults, ...fields };
  let instance = Object.create(ValueStore.prototype);

  instance.id        = merged.id;
  instance.type      = merged.type;
  instance.namespace = merged.namespace;
  instance.scopeID   = merged.scopeID;
  instance.ownerType = merged.ownerType;
  instance.ownerID   = merged.ownerID;
  instance.note      = merged.note;
  instance.value     = merged.value;
  instance.createdAt = merged.createdAt;

  return instance;
}

function createMockSolrService(overrides = {}) {
  return {
    indexDocuments: mock.fn(async () => ({
      responseHeader: { status: 0, QTime: 1 },
    })),
    ...overrides,
  };
}

function installMockApplication(solrService) {
  let mockApp = {
    getContext: () => ({
      getProperty: (name) => {
        if (name === 'solrService')
          return solrService;

        return null;
      },
    }),
  };

  // Install static getApplication on ValueStore
  ValueStore.getApplication = () => mockApp;

  return mockApp;
}

function removeMockApplication() {
  delete ValueStore.getApplication;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ValueStore onAfterSave — Solr Indexing', () => {
  let solrService;
  let consoleErrorMock;

  beforeEach(() => {
    solrService = createMockSolrService();
    installMockApplication(solrService);
    consoleErrorMock = mock.method(console, 'error', () => {});
  });

  afterEach(() => {
    removeMockApplication();
    consoleErrorMock.mock.restore();
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe('happy paths', () => {
    it('calls solrService.indexDocuments() on afterSave', async () => {
      let instance = createMockInstance();
      await instance.onAfterSave({});

      assert.equal(solrService.indexDocuments.mock.callCount(), 1);
    });

    it('passes the correctly mapped document to indexDocuments()', async () => {
      let instance = createMockInstance({
        id:        'vs_doc1',
        type:      'agent_config',
        namespace: 'config',
        scopeID:   'ses_abc',
        ownerType: 'User',
        ownerID:   'usr_42',
        note:      'My note',
        value:     '{"key":"val"}',
        createdAt: '2026-01-15T08:30:00.000Z',
      });

      await instance.onAfterSave({});

      let call = solrService.indexDocuments.mock.calls[0];
      let doc  = call.arguments[0];

      assert.deepStrictEqual(doc, {
        id:         'vs_doc1',
        doc_type:   'value_store',
        type:       'agent_config',
        namespace:  'config',
        sessionID:  'ses_abc',
        authorType: 'User',
        authorID:   'usr_42',
        note:       'My note',
        content:    '{"key":"val"}',
        timestamp:  new Date('2026-01-15T08:30:00.000Z').getTime(),
        hidden:     false,
        archived:   false,
      });
    });

    it('works for update (save on existing record)', async () => {
      let instance = createMockInstance({ id: 'vs_updated' });
      await instance.onAfterSave({});

      assert.equal(solrService.indexDocuments.mock.callCount(), 1);

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.id, 'vs_updated');
    });

    it('maps doc_type to literal "value_store"', async () => {
      let instance = createMockInstance();
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.doc_type, 'value_store');
    });

    it('maps scopeID to sessionID', async () => {
      let instance = createMockInstance({ scopeID: 'ses_session1' });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.sessionID, 'ses_session1');
    });

    it('maps ownerType to authorType', async () => {
      let instance = createMockInstance({ ownerType: 'Agent' });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.authorType, 'Agent');
    });

    it('maps ownerID to authorID', async () => {
      let instance = createMockInstance({ ownerID: 'agt_99' });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.authorID, 'agt_99');
    });

    it('maps value to content', async () => {
      let instance = createMockInstance({ value: 'big blob of text' });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.content, 'big blob of text');
    });

    it('converts createdAt to epoch milliseconds for timestamp', async () => {
      let instance = createMockInstance({ createdAt: '2026-06-15T00:00:00.000Z' });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.timestamp, new Date('2026-06-15T00:00:00.000Z').getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths — Solr errors
  // ---------------------------------------------------------------------------

  describe('Solr error handling', () => {
    it('catches SolrError and logs it without throwing', async () => {
      solrService.indexDocuments = mock.fn(async () => {
        throw new SolrError('Index failed', 500, null);
      });

      let instance = createMockInstance({ id: 'vs_fail1' });

      // Must not throw
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(consoleErrorMock.mock.callCount(), 1);

      let args = consoleErrorMock.mock.calls[0].arguments;
      assert.match(args[0], /\[SolrIndexing\]/);
      assert.equal(args[1], 'vs_fail1');
    });

    it('handles 503 Service Unavailable without affecting save', async () => {
      solrService.indexDocuments = mock.fn(async () => {
        throw new SolrError('Service Unavailable', 503, null);
      });

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(consoleErrorMock.mock.callCount(), 1);
    });

    it('handles timeout error (408) without throwing', async () => {
      solrService.indexDocuments = mock.fn(async () => {
        throw new SolrError('Solr request timed out after 15000ms', 408, null);
      });

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(consoleErrorMock.mock.callCount(), 1);
    });

    it('handles generic network error without throwing', async () => {
      solrService.indexDocuments = mock.fn(async () => {
        throw new Error('fetch failed: ECONNREFUSED');
      });

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(consoleErrorMock.mock.callCount(), 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths — missing application / context / solrService
  // ---------------------------------------------------------------------------

  describe('missing application / context / solrService', () => {
    it('no-ops when getApplication() returns null', async () => {
      ValueStore.getApplication = () => null;

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(solrService.indexDocuments.mock.callCount(), 0);
      assert.equal(consoleErrorMock.mock.callCount(), 0);
    });

    it('no-ops when getApplication is not a function — error caught gracefully', async () => {
      ValueStore.getApplication = 'not-a-function';

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(solrService.indexDocuments.mock.callCount(), 0);
      // TypeError from ?.() on non-callable is caught and logged
      assert.equal(consoleErrorMock.mock.callCount(), 1);
    });

    it('no-ops when getApplication does not exist', async () => {
      removeMockApplication();

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(solrService.indexDocuments.mock.callCount(), 0);
      assert.equal(consoleErrorMock.mock.callCount(), 0);
    });

    it('no-ops when application has no getContext()', async () => {
      ValueStore.getApplication = () => ({});

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(solrService.indexDocuments.mock.callCount(), 0);
      assert.equal(consoleErrorMock.mock.callCount(), 0);
    });

    it('no-ops when context has no solrService', async () => {
      ValueStore.getApplication = () => ({
        getContext: () => ({
          getProperty: () => null,
        }),
      });

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(solrService.indexDocuments.mock.callCount(), 0);
      assert.equal(consoleErrorMock.mock.callCount(), 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles null value — content is null in document', async () => {
      let instance = createMockInstance({ value: null });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.content, null);
    });

    it('handles null note — note is null in document', async () => {
      let instance = createMockInstance({ note: null });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.note, null);
    });

    it('handles null type — type is null in document', async () => {
      let instance = createMockInstance({ type: null });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.type, null);
    });

    it('handles null namespace — namespace is null in document', async () => {
      let instance = createMockInstance({ namespace: null });
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.namespace, null);
    });

    it('defaults timestamp to Date.now() when createdAt is null', async () => {
      let before   = Date.now();
      let instance = createMockInstance({ createdAt: null });

      await instance.onAfterSave({});

      let after = Date.now();
      let doc   = solrService.indexDocuments.mock.calls[0].arguments[0];

      assert.ok(doc.timestamp >= before, `timestamp ${doc.timestamp} should be >= ${before}`);
      assert.ok(doc.timestamp <= after, `timestamp ${doc.timestamp} should be <= ${after}`);
    });

    it('sets hidden to false', async () => {
      let instance = createMockInstance();
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.hidden, false);
    });

    it('sets archived to false', async () => {
      let instance = createMockInstance();
      await instance.onAfterSave({});

      let doc = solrService.indexDocuments.mock.calls[0].arguments[0];
      assert.equal(doc.archived, false);
    });

    it('application not initialized yet (startup race) — no crash', async () => {
      ValueStore.getApplication = () => {
        throw new Error('Application not initialized');
      };

      let instance = createMockInstance();
      await assert.doesNotReject(() => instance.onAfterSave({}));
      assert.equal(consoleErrorMock.mock.callCount(), 1);
    });
  });
});
