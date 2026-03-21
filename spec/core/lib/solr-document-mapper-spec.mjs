'use strict';

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapFrameToSolrDocuments,
  mapValueStoreToSolrDocument,
} from '../../../src/core/lib/solr-document-mapper.mjs';

// =============================================================================
// Solr Document Mapper Tests
// =============================================================================
// Pure mapping functions — no I/O, no mocking of fetch needed.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFrame(overrides = {}) {
  return {
    id:            'frm_test123',
    type:          'message',
    interactionID: 'int_test',
    authorType:    'agent',
    authorID:      'agt_test',
    timestamp:     1711929600000,
    hidden:        false,
    deleted:       false,
    groupType:     null,
    getContentForIndexing: () => [{ field: 'content', value: 'test content' }],
    ...overrides,
  };
}

function mockValueStoreRecord(overrides = {}) {
  return {
    id:        'vs_test456',
    type:      'context',
    namespace: 'session',
    scopeID:   'ses_test',
    ownerType: 'agent',
    ownerID:   'agt_test',
    note:      'A test note',
    value:     'stored value here',
    createdAt: '2024-04-01T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mapFrameToSolrDocuments — Happy Paths
// ---------------------------------------------------------------------------

describe('mapFrameToSolrDocuments', () => {
  describe('happy paths', () => {
    it('returns an array', () => {
      let result = mapFrameToSolrDocuments(mockFrame(), 'ses_abc');
      assert.ok(Array.isArray(result));
    });

    it('maps all metadata fields correctly', () => {
      let frame  = mockFrame();
      let docs   = mapFrameToSolrDocuments(frame, 'ses_abc');

      assert.equal(docs.length, 1);

      let doc = docs[0];
      assert.equal(doc.id, 'frm_test123');
      assert.equal(doc.doc_type, 'frame');
      assert.equal(doc.type, 'message');
      assert.equal(doc.sessionID, 'ses_abc');
      assert.equal(doc.interactionID, 'int_test');
      assert.equal(doc.authorType, 'agent');
      assert.equal(doc.authorID, 'agt_test');
      assert.equal(doc.timestamp, 1711929600000);
      assert.equal(doc.hidden, false);
      assert.equal(doc.archived, false);
    });

    it('translates deleted: true to archived: true', () => {
      let docs = mapFrameToSolrDocuments(mockFrame({ deleted: true }), 'ses_abc');
      assert.equal(docs[0].archived, true);
    });

    it('translates deleted: false to archived: false', () => {
      let docs = mapFrameToSolrDocuments(mockFrame({ deleted: false }), 'ses_abc');
      assert.equal(docs[0].archived, false);
    });

    it('calls getContentForIndexing() and spreads results into doc', () => {
      let called = false;
      let frame  = mockFrame({
        getContentForIndexing: () => {
          called = true;
          return [{ field: 'content', value: 'hello world' }];
        },
      });

      let docs = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.ok(called, 'getContentForIndexing was not called');
      assert.equal(docs[0].content, 'hello world');
    });

    it('sets content fields from getContentForIndexing() correctly', () => {
      let frame = mockFrame({
        getContentForIndexing: () => [
          { field: 'content', value: 'main text' },
          { field: 'note', value: 'side note' },
        ],
      });

      let doc = mapFrameToSolrDocuments(frame, 'ses_abc')[0];
      assert.equal(doc.content, 'main text');
      assert.equal(doc.note, 'side note');
    });
  });

  // -------------------------------------------------------------------------
  // Sad paths
  // -------------------------------------------------------------------------

  describe('sad paths', () => {
    it('returns [] when frame is null', () => {
      let result = mapFrameToSolrDocuments(null, 'ses_abc');
      assert.deepEqual(result, []);
    });

    it('returns [] when frame is undefined', () => {
      let result = mapFrameToSolrDocuments(undefined, 'ses_abc');
      assert.deepEqual(result, []);
    });

    it('returns doc even when frame has no id (let Solr reject it)', () => {
      let docs = mapFrameToSolrDocuments(mockFrame({ id: undefined }), 'ses_abc');
      assert.equal(docs.length, 1);
      assert.equal(docs[0].id, undefined);
    });

    it('returns metadata-only doc when getContentForIndexing() returns empty array', () => {
      let frame = mockFrame({ getContentForIndexing: () => [] });
      let docs  = mapFrameToSolrDocuments(frame, 'ses_abc');

      assert.equal(docs.length, 1);
      assert.equal(docs[0].id, 'frm_test123');
      assert.equal(docs[0].content, undefined);
    });

    it('handles getContentForIndexing() returning non-array gracefully', () => {
      let frame = mockFrame({ getContentForIndexing: () => 'not an array' });
      let docs  = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.equal(docs.length, 1);
      // Should not throw; content fields just won't be set
    });

    it('handles getContentForIndexing() returning null gracefully', () => {
      let frame = mockFrame({ getContentForIndexing: () => null });
      let docs  = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.equal(docs.length, 1);
    });

    it('handles getContentForIndexing() throwing an error gracefully', () => {
      let frame = mockFrame({
        getContentForIndexing: () => { throw new Error('boom'); },
      });
      let docs = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.equal(docs.length, 1);
      // Should not throw; just skip content
    });

    it('handles frame with null sessionID', () => {
      let docs = mapFrameToSolrDocuments(mockFrame(), null);
      assert.equal(docs[0].sessionID, null);
    });

    it('handles frame with null authorType and authorID', () => {
      let docs = mapFrameToSolrDocuments(
        mockFrame({ authorType: null, authorID: null }),
        'ses_abc',
      );
      assert.equal(docs[0].authorType, null);
      assert.equal(docs[0].authorID, null);
    });

    it('does not throw when frame has no getContentForIndexing method', () => {
      let frame = mockFrame();
      delete frame.getContentForIndexing;

      let docs = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.equal(docs.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns [] for phantom frames (groupType === "phantom")', () => {
      let frame = mockFrame({ groupType: 'phantom' });
      let result = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.deepEqual(result, []);
    });

    it('preserves hidden: true in the Solr document', () => {
      let docs = mapFrameToSolrDocuments(mockFrame({ hidden: true }), 'ses_abc');
      assert.equal(docs[0].hidden, true);
    });

    it('preserves hidden: false in the Solr document', () => {
      let docs = mapFrameToSolrDocuments(mockFrame({ hidden: false }), 'ses_abc');
      assert.equal(docs[0].hidden, false);
    });

    it('when multiple content entries share the same field, last one wins', () => {
      let frame = mockFrame({
        getContentForIndexing: () => [
          { field: 'content', value: 'first' },
          { field: 'content', value: 'second' },
        ],
      });

      let doc = mapFrameToSolrDocuments(frame, 'ses_abc')[0];
      assert.equal(doc.content, 'second');
    });

    it('defaults hidden to false when not present on frame', () => {
      let frame = mockFrame();
      delete frame.hidden;

      let docs = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.equal(docs[0].hidden, false);
    });

    it('defaults archived to false when deleted not present on frame', () => {
      let frame = mockFrame();
      delete frame.deleted;

      let docs = mapFrameToSolrDocuments(frame, 'ses_abc');
      assert.equal(docs[0].archived, false);
    });
  });
});

// ---------------------------------------------------------------------------
// mapValueStoreToSolrDocument — Happy Paths
// ---------------------------------------------------------------------------

describe('mapValueStoreToSolrDocument', () => {
  describe('happy paths', () => {
    it('maps all fields correctly', () => {
      let record = mockValueStoreRecord();
      let doc    = mapValueStoreToSolrDocument(record);

      assert.equal(doc.id, 'vs_test456');
      assert.equal(doc.doc_type, 'value_store');
      assert.equal(doc.type, 'context');
      assert.equal(doc.namespace, 'session');
      assert.equal(doc.sessionID, 'ses_test');
      assert.equal(doc.authorType, 'agent');
      assert.equal(doc.authorID, 'agt_test');
      assert.equal(doc.note, 'A test note');
      assert.equal(doc.content, 'stored value here');
      assert.equal(doc.hidden, false);
      assert.equal(doc.archived, false);
    });

    it('translates scopeID to sessionID', () => {
      let doc = mapValueStoreToSolrDocument(mockValueStoreRecord({ scopeID: 'ses_xyz' }));
      assert.equal(doc.sessionID, 'ses_xyz');
    });

    it('translates ownerType to authorType', () => {
      let doc = mapValueStoreToSolrDocument(mockValueStoreRecord({ ownerType: 'user' }));
      assert.equal(doc.authorType, 'user');
    });

    it('translates ownerID to authorID', () => {
      let doc = mapValueStoreToSolrDocument(mockValueStoreRecord({ ownerID: 'usr_abc' }));
      assert.equal(doc.authorID, 'usr_abc');
    });

    it('converts createdAt string to epoch milliseconds', () => {
      let doc = mapValueStoreToSolrDocument(
        mockValueStoreRecord({ createdAt: '2024-04-01T12:00:00.000Z' }),
      );
      assert.equal(doc.timestamp, new Date('2024-04-01T12:00:00.000Z').getTime());
    });

    it('returns a plain object (not an array)', () => {
      let doc = mapValueStoreToSolrDocument(mockValueStoreRecord());
      assert.ok(!Array.isArray(doc));
      assert.equal(typeof doc, 'object');
    });
  });

  // -------------------------------------------------------------------------
  // Sad paths
  // -------------------------------------------------------------------------

  describe('sad paths', () => {
    it('returns doc with defaults when record has null for every field', () => {
      let record = {
        id:        null,
        type:      null,
        namespace: null,
        scopeID:   null,
        ownerType: null,
        ownerID:   null,
        note:      null,
        value:     null,
        createdAt: null,
      };

      let doc = mapValueStoreToSolrDocument(record);
      assert.equal(doc.id, null);
      assert.equal(doc.doc_type, 'value_store');
      assert.equal(doc.type, null);
      assert.equal(doc.namespace, null);
      assert.equal(doc.sessionID, null);
      assert.equal(doc.authorType, null);
      assert.equal(doc.authorID, null);
      assert.equal(doc.note, null);
      assert.equal(doc.content, null);
      assert.equal(doc.hidden, false);
      assert.equal(doc.archived, false);
      assert.equal(typeof doc.timestamp, 'number');
    });

    it('defaults timestamp to Date.now() when createdAt is null', () => {
      let before = Date.now();
      let doc    = mapValueStoreToSolrDocument(mockValueStoreRecord({ createdAt: null }));
      let after  = Date.now();

      assert.ok(doc.timestamp >= before);
      assert.ok(doc.timestamp <= after);
    });

    it('sets content to null when value is null', () => {
      let doc = mapValueStoreToSolrDocument(mockValueStoreRecord({ value: null }));
      assert.equal(doc.content, null);
    });

    it('sets note to null when note is null', () => {
      let doc = mapValueStoreToSolrDocument(mockValueStoreRecord({ note: null }));
      assert.equal(doc.note, null);
    });

    it('does not throw when record is null', () => {
      let doc = mapValueStoreToSolrDocument(null);
      assert.equal(doc.doc_type, 'value_store');
    });

    it('does not throw when record is undefined', () => {
      let doc = mapValueStoreToSolrDocument(undefined);
      assert.equal(doc.doc_type, 'value_store');
    });

    it('handles missing fields gracefully (sparse object)', () => {
      let doc = mapValueStoreToSolrDocument({ id: 'vs_sparse' });
      assert.equal(doc.id, 'vs_sparse');
      assert.equal(doc.doc_type, 'value_store');
      assert.equal(doc.type, undefined);
    });
  });
});
