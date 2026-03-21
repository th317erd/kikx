'use strict';

import { BasePluginClass } from '../../routing/base-plugin-class.mjs';
import { mapFrameToSolrDocuments } from '../../lib/solr-document-mapper.mjs';

// =============================================================================
// Solr Indexing Plugin
// =============================================================================
// Registers for ALL frame types via the FrameRouter and performs best-effort
// indexing into Solr on every commit. Errors are logged but never propagated
// — the middleware chain is ALWAYS continued.
//
// The SolrService is resolved lazily from the closure-captured global context
// at process time (not setup time), because it may be registered after plugins
// load.
// =============================================================================

export function setup({ registerSelector, context }) {
  class SolrIndexingPlugin extends BasePluginClass {
    async process(next, done) {
      // 1. Lazy resolve solrService from the closure-captured global context
      let solrService = context.getProperty('solrService');
      if (!solrService)
        return await next(this.context);

      // 2. Get frame and session from the per-routing-cycle context
      let frame     = this.context.newFrame;
      let sessionID = this.context.session && this.context.session.id;

      // 3. Skip phantom frames and null/undefined frames
      if (!frame || (frame.groupType === 'phantom'))
        return await next(this.context);

      // 4. Best-effort indexing
      try {
        let documents = mapFrameToSolrDocuments(frame, sessionID);
        if (documents.length > 0)
          await solrService.indexDocuments(documents);
      } catch (error) {
        this.logger.error('[SolrIndexing] Failed to index frame:', frame.id, error.message);
      }

      // 5. ALWAYS continue the chain
      return await next(this.context);
    }
  }

  registerSelector('type:*', SolrIndexingPlugin);
}
