'use strict';

// =============================================================================
// SearchController — Full-text search via Solr
// =============================================================================
// Extends ControllerAuthBase. Two endpoints:
//   POST /api/v2/search                       → search()
//   POST /api/v2/sessions/:sessionID/search   → sessionSearch()
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';
import { SolrError }         from '../../core/lib/solr-service.mjs';

const MAX_PREVIEW_LENGTH = 1024;
const DEFAULT_ROWS       = 10;
const MAX_ROWS           = 100;

export class SearchController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // POST /api/v2/search
  // ---------------------------------------------------------------------------

  async search({ params, query, body }) {
    let {
      q,
      rows,
      start,
      sessionIDs,
      includeArchived,
      highlight,
    } = body || {};

    // --- Validate q ---
    if (!q || typeof q !== 'string')
      this.throwBadRequestError('q (query) is required');

    // --- Normalize pagination ---
    rows  = (typeof rows === 'number' && rows >= 1) ? Math.min(rows, MAX_ROWS) : DEFAULT_ROWS;
    start = (typeof start === 'number' && start >= 0) ? start : 0;

    // --- Build filter queries ---
    let filterQueries = [];

    if (!includeArchived)
      filterQueries.push('-archived:true');

    if (Array.isArray(sessionIDs) && sessionIDs.length > 0)
      filterQueries.push(`sessionID:(${sessionIDs.join(' OR ')})`);

    // --- Build Solr options ---
    let solrOptions = {
      rows,
      start,
      defType:       'edismax',
      filterQueries: (filterQueries.length > 0) ? filterQueries : undefined,
    };

    if (highlight)
      solrOptions.highlight = { fields: '_text_' };

    // --- Call Solr ---
    let solrResponse;

    try {
      let solrService = this.getSolrService();
      solrResponse    = await solrService.search(q, solrOptions);
    } catch (error) {
      if (error instanceof SolrError) {
        // Connection refused or timeout → 503
        if (error.status === 0 || error.status === 408) {
          this.setStatusCode(503);
          return { error: { message: 'Search service temporarily unavailable' } };
        }

        // Other Solr errors → 500
        this.setStatusCode(500);
        return { error: { message: error.message || 'Search service error' } };
      }

      throw error;
    }

    // --- Enrich results from DB ---
    let enrichedResults = await this._enrichResults(solrResponse.response.docs);

    return {
      data: {
        query:       q,
        resultCount: solrResponse.response.numFound,
        pagination:  { rows, start, total: solrResponse.response.numFound },
        results:     enrichedResults,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/search
  // ---------------------------------------------------------------------------

  async sessionSearch({ params, query, body }) {
    let sessionID = params.sessionID;

    // Override sessionIDs with the URL param
    let mergedBody = { ...(body || {}), sessionIDs: [ sessionID ] };

    return this.search({ params, query, body: mergedBody });
  }

  // ---------------------------------------------------------------------------
  // Private: enrich Solr docs with DB records
  // ---------------------------------------------------------------------------

  async _enrichResults(solrDocs) {
    let { Frame, ValueStore } = this.getCoreModels();
    let results = [];

    for (let doc of solrDocs) {
      try {
        let record;

        if (doc.doc_type === 'frame')
          record = await Frame.where.id.EQ(doc.id).first();
        else if (doc.doc_type === 'value_store')
          record = await ValueStore.where.id.EQ(doc.id).first();
        else
          continue; // Unknown doc_type → skip

        if (!record)
          continue; // Deleted between Solr and DB → skip

        let enriched = this._buildResult(doc, record);

        if (enriched)
          results.push(enriched);
      } catch (_error) {
        // DB error during enrichment → skip this record, don't crash
        continue;
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private: build a single enriched result object
  // ---------------------------------------------------------------------------

  _buildResult(doc, record) {
    let rawContent = this._extractContent(doc.doc_type, record);
    let contentStr = (rawContent != null) ? String(rawContent) : '';
    let contentSize = contentStr.length;
    let preview;
    let contentRange;

    if (contentSize <= MAX_PREVIEW_LENGTH) {
      preview      = contentStr;
      contentRange = null;
    } else {
      preview      = contentStr.slice(0, MAX_PREVIEW_LENGTH);
      contentRange = [ 0, MAX_PREVIEW_LENGTH ];
    }

    return {
      id:          doc.id,
      doc_type:    doc.doc_type,
      type:        record.type || null,
      sessionID:   (doc.doc_type === 'value_store') ? (record.scopeID || null) : (record.sessionID || null),
      authorType:  (doc.doc_type === 'value_store') ? (record.ownerType || null) : (record.authorType || null),
      timestamp:   record.createdAt || null,
      preview,
      contentSize,
      contentRange,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: extract text content from a DB record
  // ---------------------------------------------------------------------------

  _extractContent(docType, record) {
    if (docType === 'frame') {
      let content = (typeof record.getContent === 'function') ? record.getContent() : record.content;

      if (content == null)
        return null;

      if (typeof content === 'object') {
        // Prefer text, then html, then stringify
        if (content.text)
          return content.text;

        if (content.html)
          return content.html;

        return JSON.stringify(content);
      }

      return content;
    }

    if (docType === 'value_store')
      return record.value;

    return null;
  }
}
