'use strict';

// =============================================================================
// Search Plugin
// =============================================================================
// Provides a search:query agent tool for full-text search across session
// frames and tool logs via Solr. Returns enriched results with content
// previews and chunk-fetch guidance for truncated content.
//
// Tools registered:
//   search:query — full-text search with eDisMax, filtering, pagination
//
// Dependencies (via context):
//   solrService — SolrService instance for Solr queries
//   models      — { Frame, ValueStore } for DB enrichment
// =============================================================================

/**
 * @param {(cb: (ctx: { registry: any }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry }) => {
    let PluginInterface = registry.getClass('PluginInterface');

    // ---------------------------------------------------------------------------
    // search:query — Full-text search across frames and tool logs
    // ---------------------------------------------------------------------------

    class SearchQueryTool extends PluginInterface {
      static pluginID    = 'search';
      static featureName = 'query';
      static displayName = 'Search';
      static description = 'Full-text search across session frames and tool logs';
      static riskLevel    = 'none';
      static skipToolLog  = true;
      static inputSchema  = {
        type:       'object',
        properties: {
          query:     { type: 'string', description: 'Search query (eDisMax syntax)' },
          rows:      { type: 'number', description: 'Max results (default 10, max 50)' },
          sessionID: { type: 'string', description: 'Session to search (default: current session)' },
          docType:   { type: 'string', description: 'Filter by doc_type: frame or value_store' },
          frameType: { type: 'string', description: 'Filter by frame type: message, tool-call, etc.' },
        },
        required: ['query'],
      };

      /**
       * @param {{ query: string, rows?: number, sessionID?: string, docType?: string, frameType?: string, _sessionID?: string }} params
       * @returns {Promise<{ query: string, resultCount: number, results: any[], message: string }>}
       */
      async _execute(params) {
        let { query, rows, sessionID, docType, frameType, _sessionID } = params;

        if (!query || typeof query !== 'string')
          throw new Error('query is required and must be a string');

        let solrService = this._context.getProperty('solrService');
        if (!solrService)
          throw new Error('Search is not configured — Solr service is unavailable');

        // Cap rows at 50 for agent tools
        rows = Math.min(Math.max(parseInt(rows, 10) || 10, 1), 50);

        // Default to current session
        let effectiveSessionID = sessionID || _sessionID;

        // Build filter queries
        let filterQueries = [];
        if (effectiveSessionID)
          filterQueries.push(`sessionID:${effectiveSessionID}`);
        if (docType)
          filterQueries.push(`doc_type:${docType}`);
        if (frameType)
          filterQueries.push(`type:${frameType}`);

        // Wrap entire search in a timeout to prevent hanging the interaction loop
        let result = await Promise.race([
          this._searchAndEnrich(solrService, query, rows, filterQueries),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Search timed out after 10 seconds')), 10000)),
        ]);

        return result;
      }

      /**
       * @param {any} solrService
       * @param {string} query
       * @param {number} rows
       * @param {string[]} filterQueries
       * @returns {Promise<{ query: string, resultCount: number, results: any[], message: string }>}
       */
      async _searchAndEnrich(solrService, query, rows, filterQueries) {
        // Search Solr
        let solrResponse = await solrService.search(query, {
          rows,
          filterQueries,
          fields: ['id', 'doc_type'],
        });

        let docs     = solrResponse.response?.docs || [];
        let numFound = solrResponse.response?.numFound || 0;

        // Enrich from DB
        let models = this._context.getProperty('models');

        // If models not available, return IDs only
        if (!models)
          return { query, resultCount: numFound, results: docs, message: `Found ${numFound} results (DB enrichment unavailable)` };

        let results = [];

        for (let doc of docs) {
          try {
            let record;
            if (doc.doc_type === 'frame' && models.Frame)
              record = await models.Frame.where.id.EQ(doc.id).first();
            else if (models.ValueStore)
              record = await models.ValueStore.where.id.EQ(doc.id).first();

            if (!record)
              continue;

            // Build preview
            let content = (doc.doc_type === 'frame')
              ? (record.getContent?.()?.text || record.getContent?.()?.html || record.content || '')
              : (record.value || '');

            if (typeof content !== 'string')
              content = JSON.stringify(content);

            let contentSize  = content.length;
            let preview      = content.slice(0, 1024);
            let contentRange = (contentSize > 1024) ? [0, 1024] : null;

            results.push({
              id:           record.id,
              doc_type:     doc.doc_type,
              type:         record.type || null,
              sessionID:    (doc.doc_type === 'frame') ? record.sessionID : record.scopeID,
              preview,
              contentSize,
              contentRange,
            });
          } catch (_err) {
            // Skip failed enrichments
            continue;
          }
        }

        // Build message with chunk-fetch hints
        let message        = `Found ${numFound} results matching "${query}"`;
        let truncatedCount = results.filter((r) => r.contentRange !== null).length;
        if (truncatedCount > 0)
          message += `. ${truncatedCount} result(s) truncated — use tool_log:get to fetch full content.`;

        return {
          query,
          resultCount: numFound,
          results,
          message,
        };
      }

      getHelp() {
        return {
          ...super.getHelp(),
          inputSchema: SearchQueryTool.inputSchema,
          usage:       'search:query { query: "hello world" }',
          examples:    [
            { query: 'hello world', description: 'Basic search' },
            { query: 'error', rows: 20, description: 'More results' },
            { query: 'npm install', docType: 'value_store', description: 'Search tool logs only' },
          ],
        };
      }
    }

    registry.registerTool('search:query', SearchQueryTool);
  });

  return () => {};
}
