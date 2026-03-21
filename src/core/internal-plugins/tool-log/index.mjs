'use strict';

// =============================================================================
// Tool Log Plugin
// =============================================================================
// Provides internal tools for agents to retrieve stored tool execution outputs
// from ValueStore. Tool outputs are written by ToolLogService during execution.
//
// Tools registered:
//   tool_log:get    — retrieve a stored output by tl_ key ID
//   tool_log:search — search stored outputs by tool name, session, etc.
//
// ValueStore schema used (written by ToolLogService):
//   ownerType: 'agent'
//   ownerID:   agentID
//   namespace: 'tool_log'
//   scopeID:   sessionID
//   key:       'tl_<xid>'
//   value:     JSON.stringify({ args: {...}, output: "..." })
//   note:      human-readable summary (e.g. shell command)
//   type:      'tool_log:<pluginID>:<toolName>'
// =============================================================================

export function setup({ registerTool, PluginInterface }) {

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Apply char or line slicing to a string.
  // Returns { content, actualStart, actualEnd }
  function applySlice(output, contentStart, contentEnd, contentLines) {
    let start = (typeof contentStart === 'number' && contentStart >= 0) ? contentStart : 0;

    if (contentLines) {
      // Line-number slicing (1-based is NOT used — line 0 = first line)
      let lines = output.split('\n');

      // Clamp start to valid range
      if (start >= lines.length) {
        return { content: '', actualStart: start, actualEnd: start };
      }

      let end = (contentEnd == null || contentEnd === undefined)
        ? lines.length
        : Math.min(contentEnd, lines.length);

      if (end < start)
        end = start;

      let sliced = lines.slice(start, end).join('\n');
      return { content: sliced, actualStart: start, actualEnd: end };
    } else {
      // Character slicing
      let len = output.length;
      let clampedStart = Math.min(start, len);

      let end = (contentEnd == null || contentEnd === undefined)
        ? len
        : Math.min(contentEnd, len);

      if (end < clampedStart)
        end = clampedStart;

      let content = output.slice(clampedStart, end);
      return { content, actualStart: clampedStart, actualEnd: end };
    }
  }

  // Extract toolName from the type field (e.g. 'tool_log:shell:execute' -> 'shell:execute')
  function toolNameFromType(type) {
    if (!type)
      return '';

    // type format: 'tool_log:<pluginID>:<toolName>'
    let parts = type.split(':');
    if (parts.length >= 3)
      return parts.slice(1).join(':');

    return type;
  }

  // ---------------------------------------------------------------------------
  // tool_log:get
  // ---------------------------------------------------------------------------

  class GetToolLogTool extends PluginInterface {
    static pluginID    = 'tool-log';
    static featureName = 'get';
    static displayName = 'Get Tool Log';
    static description = 'Retrieve a stored tool execution output by ID';
    static riskLevel   = 'none';
    static inputSchema = {
      type:       'object',
      required:   ['id'],
      properties: {
        id: {
          type:        'string',
          description: 'The tl_ ID from the pointer message',
        },
        content_start: {
          type:        'integer',
          description: 'Start char/line position (default 0)',
        },
        content_end: {
          type:        ['integer', 'null'],
          description: 'End position (null = all)',
        },
        content_lines: {
          type:        'boolean',
          description: 'If true, start/end are line numbers',
        },
      },
    };

    async _execute(params) {
      // Validate required id argument
      if (!params.id || typeof params.id !== 'string' || params.id.trim() === '') {
        let error     = new Error('id is required');
        error.code    = 'MISSING_ID';
        throw error;
      }

      // Validate content_end >= content_start if both are provided
      let contentStart = (typeof params.content_start === 'number') ? params.content_start : 0;
      let contentEnd   = (params.content_end !== undefined && params.content_end !== null)
        ? params.content_end
        : null;

      if (contentEnd !== null && contentEnd < contentStart) {
        let error  = new Error('content_end must be >= content_start');
        error.code = 'INVALID_RANGE';
        throw error;
      }

      let models  = this._context.getProperty('models');
      let agentID = params.agentID;

      // Look up the entry by key (not by id — key is the 'tl_...' value)
      let entry = await models.ValueStore
        .where.key.EQ(params.id)
        .AND.namespace.EQ('tool_log')
        .first();

      if (!entry) {
        let error  = new Error('Tool log entry not found');
        error.code = 'NOT_FOUND';
        throw error;
      }

      // Access control: only the owning agent can read their own entries
      if (entry.ownerID !== agentID) {
        let error  = new Error('Access denied');
        error.code = 'FORBIDDEN';
        throw error;
      }

      // Parse stored value JSON
      let parsed;
      try {
        parsed = JSON.parse(entry.value);
      } catch (_e) {
        let error  = new Error('Stored tool log entry has corrupted value');
        error.code = 'CORRUPTED';
        throw error;
      }

      let output = '';
      if (parsed && parsed.output != null) {
        output = (typeof parsed.output === 'string')
          ? parsed.output
          : JSON.stringify(parsed.output, null, 2);
      }

      // Apply content slicing
      let { content, actualStart, actualEnd } = applySlice(
        output, contentStart, contentEnd, !!params.content_lines,
      );

      return {
        id:            entry.key,
        toolName:      toolNameFromType(entry.type),
        note:          entry.note || null,
        outputLength:  output.length,
        content,
        content_start: actualStart,
        content_end:   actualEnd,
        content_lines: !!params.content_lines,
        createdAt:     entry.createdAt,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // tool_log:search
  // ---------------------------------------------------------------------------

  class SearchToolLogTool extends PluginInterface {
    static pluginID    = 'tool-log';
    static featureName = 'search';
    static displayName = 'Search Tool Log';
    static description = 'Search stored tool execution outputs by tool name, session, or date';
    static riskLevel   = 'none';
    static inputSchema = {
      type:       'object',
      properties: {
        query: {
          type:        'string',
          description: 'Wildcard search on type and note fields',
        },
        toolName: {
          type:        'string',
          description: 'Exact or wildcard match on type field (e.g. "shell:execute")',
        },
        sessionID: {
          type:        'string',
          description: 'Restrict to a specific session (scopeID)',
        },
        before: {
          type:        'string',
          description: 'Entries created before this ISO timestamp',
        },
        after: {
          type:        'string',
          description: 'Entries created after this ISO timestamp',
        },
        limit: {
          type:        'integer',
          description: 'Maximum results (default 10, max 100)',
        },
        offset: {
          type:        'integer',
          description: 'Skip first N results (default 0)',
        },
        content_start: {
          type:        'integer',
          description: 'Content slice start for each result (default 0)',
        },
        content_end: {
          type:        'integer',
          description: 'Content slice end for each result (default 256)',
        },
        content_lines: {
          type:        'boolean',
          description: 'If true, start/end are line numbers',
        },
      },
    };

    async _execute(params) {
      let solrService = this._context.getProperty('solrService');

      if (solrService) {
        try {
          return await this._executeWithSolr(solrService, params);
        } catch (error) {
          console.warn('[tool_log:search] Solr search failed, falling back to SQLite:', error.message);
        }
      }

      // Fall back to existing SQLite implementation
      return await this._executeWithSQLite(params);
    }

    // -----------------------------------------------------------------------
    // Solr-backed search
    // -----------------------------------------------------------------------

    async _executeWithSolr(solrService, params) {
      let models  = this._context.getProperty('models');
      let agentID = params.agentID;

      // Pagination params with defaults and clamping
      let rawLimit = (typeof params.limit  === 'number') ? params.limit  : 10;
      let offset   = (typeof params.offset === 'number') ? params.offset : 0;
      let limit    = (rawLimit <= 0) ? 10 : Math.min(rawLimit, 100);

      // Content slice defaults for search previews
      let contentStart = (typeof params.content_start === 'number') ? params.content_start : 0;
      let contentEnd   = (typeof params.content_end   === 'number') ? params.content_end   : 256;
      let contentLines = !!params.content_lines;

      // Build Solr query
      let query = (params.query && params.query.trim()) ? params.query : '*:*';

      // Build filter queries
      let filterQueries = [
        'doc_type:value_store',
        'namespace:tool_log',
        `authorID:${agentID}`,
      ];

      if (params.sessionID)
        filterQueries.push(`sessionID:${params.sessionID}`);

      if (params.toolName)
        filterQueries.push(`type:"tool_log:${params.toolName}"`);

      if (params.before) {
        let beforeDate = new Date(params.before);
        if (!isNaN(beforeDate.getTime()))
          filterQueries.push(`timestamp:[* TO ${beforeDate.getTime()}]`);
      }

      if (params.after) {
        let afterDate = new Date(params.after);
        if (!isNaN(afterDate.getTime()))
          filterQueries.push(`timestamp:[${afterDate.getTime()} TO *]`);
      }

      // Execute Solr search
      let solrResult = await solrService.search(query, {
        filterQueries,
        fields:      'id',
        rows:        limit,
        start:       offset,
        queryFields: 'content',
      });

      let docs = solrResult.response.docs;

      if (docs.length === 0)
        return [];

      // Fetch full ValueStore records by key (Solr id = ValueStore key for value_store docs)
      let docIDs = docs.map((d) => d.id);

      // Mythix ORM lacks .IN(), so fetch each record individually
      let entries = await Promise.all(
        docIDs.map((key) =>
          models.ValueStore.where.key.EQ(key).AND.namespace.EQ('tool_log').first(),
        ),
      );

      // Build a map for O(1) lookup, preserving Solr ordering
      let entryMap = new Map();
      for (let entry of entries) {
        if (entry)
          entryMap.set(entry.key, entry);
      }

      // Build results in Solr's order
      let results = [];

      for (let docID of docIDs) {
        let entry = entryMap.get(docID);

        if (!entry)
          continue;

        let output = '';
        try {
          let parsed = JSON.parse(entry.value);
          if (parsed && typeof parsed.output === 'string')
            output = parsed.output;
        } catch (_e) {
          // Corrupted entry — return empty preview
        }

        let { content, actualStart, actualEnd } = applySlice(
          output, contentStart, contentEnd, contentLines,
        );

        results.push({
          id:              entry.key,
          toolName:        toolNameFromType(entry.type),
          note:            entry.note || null,
          outputLength:    output.length,
          content_preview: content,
          content_start:   actualStart,
          content_end:     actualEnd,
          content_lines:   contentLines,
          createdAt:       entry.createdAt,
        });
      }

      return results;
    }

    // -----------------------------------------------------------------------
    // SQLite fallback (original implementation)
    // -----------------------------------------------------------------------

    async _executeWithSQLite(params) {
      let models  = this._context.getProperty('models');
      let agentID = params.agentID;

      // Pagination params with defaults and clamping
      let rawLimit  = (typeof params.limit  === 'number') ? params.limit  : 10;
      let offset    = (typeof params.offset === 'number') ? params.offset : 0;

      // Clamp limit: 0 -> 10 (default), >100 -> 100 (max)
      let limit = (rawLimit <= 0) ? 10 : Math.min(rawLimit, 100);

      // Content slice defaults for search previews
      let contentStart = (typeof params.content_start === 'number') ? params.content_start : 0;
      let contentEnd   = (typeof params.content_end   === 'number') ? params.content_end   : 256;
      let contentLines = !!params.content_lines;

      // Build base query — only calling agent's own entries
      let q = models.ValueStore
        .where.ownerType.EQ('agent')
        .AND.ownerID.EQ(agentID)
        .AND.namespace.EQ('tool_log');

      // Filter by sessionID (scopeID)
      if (params.sessionID)
        q = q.AND.scopeID.EQ(params.sessionID);

      // Filter by toolName — match against type field
      // type format is 'tool_log:<pluginID>:<toolName>' so we prefix-match
      if (params.toolName) {
        let typeFilter = `tool_log:${params.toolName}`;
        q = q.AND.type.EQ(typeFilter);
      }

      // Fetch all matching entries (we'll filter in-JS for query/before/after)
      let entries = await q.all();

      // In-JS filtering for query (wildcard match on type and note)
      if (params.query) {
        let lowerQuery = params.query.toLowerCase();
        entries = entries.filter((entry) => {
          let typeMatch = entry.type && entry.type.toLowerCase().includes(lowerQuery);
          let noteMatch = entry.note && entry.note.toLowerCase().includes(lowerQuery);
          return typeMatch || noteMatch;
        });
      }

      // In-JS filtering for before/after timestamps
      if (params.before) {
        let beforeDate = new Date(params.before);
        if (!isNaN(beforeDate.getTime()))
          entries = entries.filter((e) => e.createdAt && new Date(e.createdAt) < beforeDate);
      }

      if (params.after) {
        let afterDate = new Date(params.after);
        if (!isNaN(afterDate.getTime()))
          entries = entries.filter((e) => e.createdAt && new Date(e.createdAt) > afterDate);
      }

      // Apply offset and limit
      entries = entries.slice(offset, offset + limit);

      // Build result rows with content previews
      let results = entries.map((entry) => {
        let output = '';
        try {
          let parsed = JSON.parse(entry.value);
          if (parsed && typeof parsed.output === 'string')
            output = parsed.output;
        } catch (_e) {
          // Corrupted entry — return empty preview
        }

        let { content, actualStart, actualEnd } = applySlice(
          output, contentStart, contentEnd, contentLines,
        );

        return {
          id:              entry.key,
          toolName:        toolNameFromType(entry.type),
          note:            entry.note || null,
          outputLength:    output.length,
          content_preview: content,
          content_start:   actualStart,
          content_end:     actualEnd,
          content_lines:   contentLines,
          createdAt:       entry.createdAt,
        };
      });

      return results;
    }
  }

  // ---------------------------------------------------------------------------
  // Register tools
  // ---------------------------------------------------------------------------

  registerTool('tool_log:get',    GetToolLogTool);
  registerTool('tool_log:search', SearchToolLogTool);

  return () => {};
}
