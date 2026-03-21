# Solr Indexing & Search Integration — Planning Document

> `::agis.plan` — Wire Solr as indexer + expose search
> Status: PLANNING MODE (no implementation code)

---

## Executive Summary

Wire Solr into the Kikx frame pipeline so that frames and tool logs are automatically indexed as they're created/updated. Expose search through both an HTTP API (for the client) and an agent tool (for LLM agents).

**What already exists:**
- Solr 9.10.1 Docker container (running, schema deployed)
- `SolrService` module (`src/core/lib/solr-service.mjs`) — fetch-based, 58 tests
- Solr schema with frame + tool log fields, index-only storage, English stemming, HTML stripping
- FrameRouter + BasePluginClass for event-driven frame processing
- Internal plugin system with `registerTool` and `registerSelector`

**What we're building:**
1. Document mapper (frame/tool-log → Solr doc)
2. Indexing plugin (FrameRouter, best-effort)
3. Tool log indexing (ToolLogService hook)
4. Search HTTP API (SearchController)
5. Search agent tool (internal plugin)

---

## AGIS Gauntlet Analysis

### Clarity

**Well-defined?** Yes. The path is clear:
- Frames flow through `_createFrame()` → `FramePersistence.saveFrames()` → `FrameManager.commit()` → `FrameRouter` dispatches to registered plugins
- Tool logs flow through `ToolLogService.storeToolOutput()` → `ValueStore.create()`
- Both need to be mapped to Solr documents and indexed via `SolrService.indexDocuments()`

<!-- 
Shouldn't we just add the SOLR indexing at `ValueStore.create` and `ValueStore.update`?
 -->

**Assumptions:**
1. Best-effort indexing — Solr failure never blocks frame/tool creation
2. Solr is index-only — all content retrieved from SQLite by ID <!-- And eventually from PostgreSQL -->
3. Soft commit (1s autoSoftCommit) provides near-real-time search visibility
4. Frame updates (upserts) are handled by re-indexing with same ID (Solr replaces docs on duplicate ID)
5. Session permission filtering happens at search time, not index time

### Alignment

- **Perfect architectural fit.** The FrameRouter was designed exactly for this — selector-based frame processing via plugin middleware chain.
- **No conflicts** with existing plugins (scheduling, permissions, hooks, compact).
- **Established patterns** for both the indexing side (SchedulingPlugin as selector example) and the search side (websearch/tool-log internal plugins, ControllerAuthBase controllers).

### Blind Spots (Cynic Hat)

1. **Frame updates:** Frames can be upserted via `FramePersistence.saveFrames()`. The FrameRouter fires on ALL commits (create + update), so this is automatically handled. Solr replaces the doc when the same ID is re-indexed.

2. **Frame deletion:** When `deleted: true` is set, the frame is UPDATED (not destroyed). Options:
   - (a) Delete from Solr index (clean search, but lose audit trail)
   <!-- 
   We still have an audit trail. We _do not_ **need** indexes for an audit trail. We load the slow and "linked" way, so what...?
    -->
   - (b) Re-index with `deleted: true` and filter at search time
   - **Recommendation:** Option (b) — re-index with the flag. Search adds `fq=-deleted:true` by default. Admins can override.
   <!-- 
   Sure, I am not against this. We STILL NEED to search deleted sessions for example. So for sessions at least, we will have to go this route. A "session delete" is actually always a "session archive". So an "undelete"/"unarchive" is basically an easy operation: one click away.
    -->

3. **Missed frames (Solr downtime):** If Solr is unavailable, frames are created in SQLite but NOT indexed. Recovery options:
   - Re-index script (manual catch-up)
   - Deferred for now — not MVP scope. Document as known gap.
   <!-- 
   Defer for now. We would still be able to recover. It would just be slow if we had a lot of messages we cared about.
    -->

4. **Tool log content:** ToolLogService stores full output in ValueStore. The tool-result FRAME may contain a truncated pointer (if output > 1024 chars). For full-text search of tool outputs:
   - Index tool logs as separate Solr documents (`doc_type: 'tool_log'`)
   - Pull data from ValueStore record, not from the frame
   <!-- 
   Yes... this is an interesting one. Essentially this message will be given to an _agent_, not necessarily a human. So the agent will then have to go fetch the tool result. If it is too large, the agent should fetch it in chunks (and be reminded of that in the reponse of the tool call). The size of the content should also be in the response from the tool, so the agent always knows beforhand if it is too large, and needs to be fetched in chunks.
    -->

5. **Session permissions at search time:** A user searching "hello" shouldn't see results from sessions they don't have access to. The search endpoint MUST filter by accessible sessionIDs. Agent tools are already session-scoped.

<!-- 
Yes, very true, and very important.
 -->

6. **Content extraction complexity:** Frame `content` is JSON with varying structure per frame type:
   - `user-message` / `message`: `{ text, html }`
   - `tool-call`: `{ toolName, arguments }`
   - `tool-result`: `{ result }` or `{ error }` (may be truncated pointer)
   - `tool-activity`: `{ html }` (render hint)
   - `reflection`: `{ text }`
   - `error`: `{ message }` or `{ text }`
   - `permission-denied`: `{ message }`
   - The mapper function must handle ALL of these.

   <!-- 
   Yes. If you were smart though, each one of these frames would be a class that inherits from Frame. Each would have a "getContentForIndexing" that expects an array to be returned. Then each frame class implements its own method, and walla! Problem solved.
    -->

7. **Phantom frames:** Temporary placeholders for streaming. They do get committed to FrameManager, but are replaced by real frames. The indexing plugin should skip phantoms (they'll be overwritten anyway when the real frame arrives). Filter: skip if `groupType === 'phantom'` and `type === 'tool-activity'`.

<!-- 
Yes.
 -->

### Dependencies (All Satisfied)

| Dependency | Status | Location |
|-----------|--------|----------|
| SolrService | COMPLETE | `src/core/lib/solr-service.mjs` |
| Solr Docker container | COMPLETE | `docker-compose.yml` |
| Solr schema | COMPLETE | `solr/kikx/conf/schema.xml` |
| FrameRouter | COMPLETE | `src/core/routing/frame-router.mjs` |
| BasePluginClass | COMPLETE | `src/core/routing/base-plugin-class.mjs` |
| PluginLoader + Registry | COMPLETE | `src/core/plugin-loader/` |
| Internal plugin system | COMPLETE | `src/core/internal-plugins/` (15+ plugins) |
| ControllerAuthBase | COMPLETE | `src/server/controllers/controller-auth-base.mjs` |
| Route DSL | COMPLETE | `src/server/routes/index.mjs` |

### Scope (Minimalist Hat)

**MVP deliverables (3 work items, buildable incrementally):**
1. Indexer (document mapper + FrameRouter plugin + tool log hook)
2. HTTP search API (SearchController + routes)
3. Agent search tool (internal plugin)

<!-- 
I think a number of search tools and endpoints are already in-place. The search field on the client for sessions also currently doesn't work.
 -->

**Deferred (NOT in MVP):**
- Bulk re-indexing script
- Search autocomplete/suggestions
- Faceted search
- Search analytics/logging
- Client-side search UI (separate client wave)

### Testability

| Component | Mock Strategy | Key Assertions |
|-----------|--------------|----------------|
| Document mapper | None needed (pure function) | Correct field mapping for all 10+ frame types, null/missing content handling, content extraction |
| Indexing plugin | Mock SolrService | `indexDocuments()` called with correct doc, errors caught and logged, chain continues via `next()` |
| Tool log indexing | Mock SolrService + ValueStore | Tool log → Solr doc mapping, best-effort error handling |
| SearchController | Mock SolrService | Input validation, parameter passthrough, response formatting, error responses |
| Search agent tool | Mock SolrService | Input validation, result formatting for agent consumption, session scoping |

---

## Architecture

### Component 1: Solr Document Mapper

**File:** `src/core/lib/solr-document-mapper.mjs`

**Purpose:** Pure functions that convert frame and tool-log records to Solr document objects. Zero side effects, no service dependencies.

**Exports:**
```
mapFrameToSolrDocument(frame, sessionID) → { id, doc_type, sessionID, ... }
mapToolLogToSolrDocument(valueStoreRecord) → { id, doc_type, tool_name, ... }
extractFrameContent(frame) → { text, html }
```

**`mapFrameToSolrDocument(frame, sessionID)` mapping:**

| Solr Field | Source | Notes |
|-----------|--------|-------|
| `id` | `frame.id` | Unique key |
| `doc_type` | `'frame'` | Literal |
| `sessionID` | `sessionID` param | From routing context |
| `interactionID` | `frame.interactionID` | |
| `type` | `frame.type` | user-message, message, tool-call, etc. |
| `authorType` | `frame.authorType` | user, agent, system |
| `authorID` | `frame.authorID` | |
| `content_text` | `extractFrameContent(frame).text` | Plain text extraction |
| `content_html` | `extractFrameContent(frame).html` | HTML content if present |
| `timestamp` | `frame.timestamp` | Milliseconds |
| `hidden` | `frame.hidden` | Boolean |
| `deleted` | `frame.deleted` | Boolean |

**`extractFrameContent(frame)` logic:**

```
Parse frame.content as JSON (if string) or use directly (if object)
Switch on frame.type:
  - user-message, message, reflection:
      text = content.text || null
      html = content.html || null
  - tool-call:
      text = `${content.toolName}: ${JSON.stringify(content.arguments || {})}`
      html = null
  - tool-result:
      text = (typeof content.result === 'string') ? content.result : JSON.stringify(content.result)
      html = null
  - tool-error, error:
      text = content.message || content.error || content.text || null
      html = null
  - permission-denied:
      text = content.message || content.reason || null
      html = null
  - stop, hook-blocked:
      text = content.text || content.message || null
      html = null
  - default:
      text = JSON.stringify(content)
      html = null
Return { text, html } (both may be null)
```

**`mapToolLogToSolrDocument(record)` mapping:**

| Solr Field | Source | Notes |
|-----------|--------|-------|
| `id` | `record.key` | e.g. `tl_c5lv4tev70001...` |
| `doc_type` | `'tool_log'` | Literal |
| `sessionID` | `record.scopeID` | Tool log scopeID = sessionID |
| `tool_name` | Parsed from `record.type` | `tool_log:shell:execute` → `shell:execute` |
| `tool_note` | `record.note` | Human-readable summary |
| `tool_output` | `JSON.parse(record.value).output` | Full tool output text |
| `timestamp` | `record.createdAt` or `Date.now()` | |
| `hidden` | `false` | Tool logs aren't hidden |
| `deleted` | `false` | |

**Edge cases:**
- `frame.content` is null/undefined → return empty doc (only id + doc_type + metadata)
- `frame.content` is not valid JSON string → treat as raw text
- Tool log `value` parse failure → use raw string as `tool_output`

---

### Component 2: Solr Indexing Plugin (FrameRouter)

**File:** `src/core/internal-plugins/solr-indexing/index.mjs`

**Pattern:** Same as `scheduling/index.mjs` — `setup({ registerSelector, context })` with a BasePluginClass subclass.

**Selector:** `'*'` (match all frame types)

**Behavior:**

```javascript
setup({ registerSelector, context }) {
  class SolrIndexingPlugin extends BasePluginClass {
    async process(next, done) {
      // Lazy resolve — Solr may not be configured
      let solrService = context.getProperty('solrService');
      if (!solrService)
        return await next(this.context);

      let frame     = this.context.newFrame;
      let sessionID = this.context.session && this.context.session.id;

      // Skip phantom/transient frames
      if (frame.groupType === 'phantom')
        return await next(this.context);

      try {
        let document = mapFrameToSolrDocument(frame, sessionID);
        if (document)
          await solrService.indexDocuments(document);
        
        // From User: This appears to be singular "document", but going into plural "indexDocuments"... what is happening?

      } catch (error) {
        // Best-effort — log and continue, never block the routing chain
        this.logger.error('[SolrIndexing] Failed to index frame:', frame.id, error.message);
      }

      return await next(this.context);
    }
  }

  registerSelector('*', SolrIndexingPlugin);
}
```

**Key design decisions:**
- `context.getProperty('solrService')` resolved per-invocation (lazy). If Solr isn't configured, no-op.
- `await next(this.context)` ALWAYS called — even on error. Chain must never break.
- Phantom skip: if `frame.groupType === 'phantom'`, skip indexing (real frame will replace it).
- Error isolation: try/catch wraps the entire indexing attempt.

---

### Component 3: Tool Log Solr Indexing

**Location:** Enhancement to `ToolLogService.storeToolOutput()` in `src/core/interaction/tool-log-service.mjs`

**Approach:** After successfully storing the tool log in ValueStore, attempt to index it in Solr. Same best-effort pattern already used in ToolLogService.

**Pseudocode addition:**

```javascript
// After: let entry = await ValueStore.create(record);
// Add:
try {
  let solrService = this._context.getProperty('solrService');
  if (solrService) {
    let solrDoc = mapToolLogToSolrDocument(entry);
    await solrService.indexDocuments(solrDoc);
  }
} catch (error) {
  // Best-effort — mirror existing ToolLogService error handling
  console.error('[SolrIndexing] Tool log index failed:', error.message);
}
```

**Why not a separate plugin?** Tool logs don't flow through FrameRouter — they're stored in ValueStore via ToolLogService. The cleanest integration point is right after the ValueStore write, inside the existing best-effort try/catch.

---

### Component 4: Search Controller (HTTP API)

**File:** `src/server/controllers/search-controller.mjs`

**Pattern:** Extends `ControllerAuthBase` (same as SessionController, FrameController, etc.)

**Endpoints:**

#### `POST /api/v2/search` — Global search

```
Request body:
  q:           string (required) — search query
  rows:        number (optional, default 10, max 100)
  start:       number (optional, default 0)
  sessionID:   string (optional) — scope to single session
  filterQuery: string | string[] (optional) — Solr fq filters
  highlight:   boolean (optional, default false)
  fields:      string[] (optional) — override returned fields

Response:
  { data: {
      query:        string,
      resultCount:  number,
      results:      [ { id, doc_type } ],   // Only id + doc_type from Solr
      highlighting: object | null,
      pagination:   { rows, start, total }
  } }
```

<!-- 
Let's not do this Claude. Let's have this endpoint behave a little nicer, and return the documents for the caller... let's go the extra mile.
 -->

**Session permission filtering:**
- The authenticated user's accessible sessions are determined from the request context
- If `sessionID` is provided, verify user has access to that session
- If `sessionID` is NOT provided, add `fq=sessionID:(ses_xxx OR ses_yyy OR ...)` filter for all accessible sessions
- This prevents cross-session information leakage

**Error responses:**
- 400: Missing `q` parameter
- 403: User lacks access to requested sessionID
- 500: Solr unavailable (with graceful error message)

#### `POST /api/v2/sessions/:sessionID/search` — Session-scoped search

Same as above, but `sessionID` is always extracted from the URL path. Simpler permission check (just verify session access).

---

### Component 5: Search Agent Tool

**File:** `src/core/internal-plugins/search/index.mjs`

**Tool name:** `search:query`

**Pattern:** Same as `websearch:fetch`, `tool_log:search`, etc.

```javascript
static pluginID    = 'search';
static featureName = 'query';
static displayName = 'Search';
static description = 'Full-text search across session frames and tool logs';
static inputSchema = {
  type: 'object',
  properties: {
    query:       { type: 'string', description: 'Search query (eDisMax)' },
    rows:        { type: 'number', description: 'Max results (default 10, max 50)' },
    sessionID:   { type: 'string', description: 'Session to search (default: current)' },
    docType:     { type: 'string', description: 'Filter: frame or tool_log' },
    frameType:   { type: 'string', description: 'Filter: message, tool-call, etc.' },
  },
  required: ['query'],
};
```

**Behavior:**
- Default sessionID = `_sessionID` (from augmented args — current session)
- Caps `rows` at 50 for agent tools (prevent token explosion)
- Builds filter queries from `docType` and `frameType`
- Calls `solrService.search(query, options)`
- Returns structured result with `resultCount`, `results: [{ id, doc_type, type }]`
- Since Solr only stores `id` and `doc_type`, the agent gets back IDs it can use to look up full content via other tools or the DB

<!-- 
Let's not do this Claude. Let's have this endpoint behave a little nicer, and return the documents for the caller... let's go the extra mile.
 -->

**Result format for agent:**
```javascript
{
  query:        'hello world',
  resultCount:  42,
  results: [
    { id: 'frm_xxx', doc_type: 'frame' },
    { id: 'tl_yyy',  doc_type: 'tool_log' },
  ],
  message: 'Found 42 results matching "hello world"'
}
```

---

### Component 6: Route Registration

**File:** Modify `src/server/routes/index.mjs`

**New routes:**

```javascript
// Global search
endpoint('search', {
  methods:    [ 'POST' ],
  controller: 'SearchController.search',
});

// Session-scoped search (inside existing sessions path)
endpoint('search', {
  methods:    [ 'POST' ],
  controller: 'SearchController.sessionSearch',
});
```

---

## Implementation Order

**Phase 1: Indexer (must be first — search needs indexed data)**
1. Document mapper module (pure functions, TDD)
2. SolrIndexingPlugin (FrameRouter selector registration)
3. ToolLogService Solr hook
4. Verification: send a message, check Solr has the frame indexed

**Phase 2: Search API (can run in parallel with Phase 3)**
5. SearchController
6. Route registration
7. Verification: curl search endpoint, get results

**Phase 3: Agent Tool (can run in parallel with Phase 2)**
8. Search internal plugin
9. Verification: agent uses search:query tool in a session

---

## Test Strategy

### Document Mapper Tests (`spec/core/lib/solr-document-mapper-spec.mjs`)

- `mapFrameToSolrDocument()`:
  - Maps user-message frame correctly (text + html extraction)
  - Maps message frame correctly
  - Maps tool-call frame (toolName + arguments as text)
  - Maps tool-result frame (result as text)
  - Maps tool-error frame (error/message extraction)
  - Maps reflection frame (hidden text)
  - Maps permission-denied frame
  - Maps error/stop/hook-blocked frames
  - Handles null content gracefully
  - Handles non-JSON content string
  - Handles missing sessionID
  - Sets doc_type to 'frame' always
  - Preserves boolean fields (hidden, deleted)

- `mapToolLogToSolrDocument()`:
  - Maps ValueStore record correctly
  - Extracts tool_name from type field
  - Extracts output from JSON value
  - Handles malformed value JSON
  - Handles null/missing fields
  - Sets doc_type to 'tool_log' always

- `extractFrameContent()`:
  - Returns { text, html } for each frame type
  - Handles missing content fields gracefully
  - Parses content string as JSON
  - Falls back to raw string for invalid JSON

### Indexing Plugin Tests (`spec/core/internal-plugins/solr-indexing-spec.mjs`)

- Plugin registers selector via `registerSelector`
- `process()` calls `solrService.indexDocuments()` with mapped document
- `process()` always calls `next()` even on indexing error
- `process()` skips phantom frames (`groupType === 'phantom'`)
- `process()` is a no-op when solrService is not available
- `process()` catches and logs SolrService errors
- `process()` handles timeout errors gracefully
- Concurrent indexing doesn't block or corrupt

### Tool Log Indexing Tests (additions to existing tool-log-service-spec)

- After storing tool log, calls `solrService.indexDocuments()`
- Solr indexing failure doesn't prevent tool log storage
- Solr indexing skipped when solrService not on context
- Correct Solr document structure for tool logs

### Search Controller Tests (`spec/server/controllers/search-controller-spec.mjs`)

- Returns 400 when `q` is missing
- Passes query and options to SolrService.search()
- Formats response as `{ data: { query, resultCount, results, pagination } }`
- Applies session permission filtering
- Returns 403 when user lacks session access
- Handles Solr errors with 500 response
- Respects `rows` max cap (100)
- Passes highlight option through

### Search Agent Tool Tests (`spec/core/internal-plugins/search-tool-spec.mjs`)

- Validates required `query` parameter
- Calls SolrService.search() with correct options
- Defaults sessionID to `_sessionID` (current session)
- Caps rows at 50
- Formats results for agent consumption
- Handles Solr errors with descriptive message
- Builds filter queries from docType/frameType

---

## Open Questions for User

1. **Deleted frame handling:** Re-index with `deleted: true` and filter at search time (recommended), or delete from Solr index entirely?
<!-- 
Set deleted to true, and also, we should properly call this "archived", which is what this app calls a soft-delete.
 -->

2. **Search result enrichment:** Should the search API return ONLY `id` + `doc_type` (caller does DB lookup), or should it also fetch and include content from SQLite? The former is simpler and respects index-only design. The latter is more convenient for the client.

<!-- 
Fetch and return content from the DB. We DO NOT want to return massive quantities of content... if content is too large, truncate it with a message. Just previews of each document... something sane, like whatever fits in 1024 chars.
 -->

3. **Session permission scope:** For global search (`POST /api/v2/search`), should we query for ALL sessions the user has access to, or require an explicit `sessionID`? Querying all accessible sessions could be slow for users with many sessions.

<!-- 
Allow search across all sessions the user/agent/actor has access to. Session ID(s) can be provided (I would like plural IDs to be allowed).
 -->

4. **Tool log indexing timing:** Index tool logs inside ToolLogService (simple, coupled) or via a separate event/listener (decoupled, more code)? Recommendation: inside ToolLogService, mirroring the existing best-effort pattern.

<!-- 
I would personally say index directly on the ValueStore itself. I don't really think we need specialized per-call-site document indexing here. We should have the data leveled enough that the "type" of ValueStore is included inside the SOLR indexes. Otherwise, we don't really care... index the damn thing, for every "ValueStorage" item that is saved or updated.
 -->

---

## Known Gaps (Deferred)

| Gap | Mitigation | Priority |
|-----|-----------|----------|
| Bulk re-indexing for existing data | Manual script (`scripts/solr-reindex.mjs`) | Medium (needed before production) |
| Solr downtime catch-up | Re-run reindex script | Low |
| Search autocomplete | Future enhancement | Low |
| Faceted search (by type, author, date ranges) | Schema supports it, API doesn't expose it yet | Low |
| Client-side search UI | Separate client wave | Medium |

<!--
Next round please! Append here.
 -->

---

## Round 2: User Feedback Incorporated

### Resolved Questions

All 4 open questions answered. Here are the decisions:

| Question | Decision |
|----------|----------|
| Deleted/archived handling | Re-index with `archived: true` flag. Use `fq=-archived:true` by default. Sessions use "archive" not "delete". Searching archived content must remain possible. |
| Search result enrichment | Fetch content from DB. Return previews (truncated to 1024 chars). Include content size so agents know whether to chunk-fetch. |
| Session permission scope | Search across ALL accessible sessions by default. Allow plural `sessionIDs` as optional filter. |
| ValueStore indexing | Index at the ValueStore level, not per-call-site. Every ValueStore create/update gets indexed. The `type` field discriminates (tool_log, agent_config, etc.). |

### Architecture Revisions

#### Revision 1: ValueStore-Level Indexing (replaces Component 3)

**Old plan:** Hook ToolLogService.storeToolOutput() specifically.
**New plan:** Hook ALL ValueStore writes to Solr.

**Rationale:** The user correctly identified that per-call-site indexing is needless specialization. ValueStore already has a `type` field that discriminates records (e.g., `tool_log:shell:execute`). Index everything; filter at search time.

**Challenge:** There are TWO write paths to ValueStore:
1. `ValueStoreService.set()` / `setSigned()` — the service layer
2. `ToolLogService.storeToolOutput()` → `ValueStore.create()` directly (bypasses the service)

Mythix ORM has no model lifecycle hooks (no afterCreate/afterSave). So we need to hook at the service level AND the direct-model write path.
<!-- 
Ha! You are funny... it most certainly DOES... check `model.js` at `~/Projects/mythix-ecosystem/mythix/`
 -->

**Options:**
- **(a) Refactor ToolLogService to use ValueStoreService** — Then we only hook one place. But ToolLogService has custom signing logic that doesn't map cleanly to setSigned().
- **(b) Add indexing to both ValueStoreService.set()/setSigned() AND ToolLogService.storeToolOutput()** — Two hookpoints, but no refactoring needed.
- **(c) Create a SolrAwareValueStore subclass** — Override create() and save() on the model. Both paths would be covered automatically. But this touches the model layer.

**Recommendation:** Option (b) for MVP. It's pragmatic — two hookpoints, both best-effort, zero refactoring. If we later consolidate all writes through ValueStoreService, we can remove the ToolLogService hook.

**New Solr schema consideration:** ValueStore records use different fields than frames. We need generic fields for ValueStore indexing:

| Solr Field | Source (ValueStore) | Notes |
|-----------|-------------------|-------|
| `id` | `record.id` (vs_xxx) or `record.key` (tl_xxx) | Unique |
| `doc_type` | `'value_store'` | Or more specific: derive from `record.type` |
| `sessionID` | `record.scopeID` | Empty string if no session scope |
| `tool_name` | Parsed from `record.type` if tool_log:* | `tool_log:shell:execute` → `shell:execute` |
| `tool_note` | `record.note` | Human-readable summary |
| `tool_output` | Parse `record.value` → extract output | For tool logs specifically |
| `content_text` | `record.value` (raw JSON) or parsed text | Generic ValueStore content |
| `timestamp` | `record.createdAt` | |

<!--
"note" is a generic field on a ValueStore object
"name" is a generic field on a ValueStore object
"value" is a generic field on a ValueStore object (Where is tool_output coming from?)
 -->

**Schema may need expansion** — current schema was designed for frames + tool logs. Generic ValueStore items may need additional fields (namespace, ownerType, ownerID). This is a decision point: do we index ALL ValueStore items (agent configs, session contexts, user settings), or just tool logs?

<!-- 
I've already told you that we probably need to add some extra field to ValueStore
 -->

**Question back to user:** You said "index the damn thing, for every ValueStorage item that is saved or updated." Does this mean ALL namespaces (agent_config, session_context, user_settings, tool_log), or specifically tool_log namespace? Indexing agent configs feels like noise in search results — but maybe you want them searchable too?

<!-- 
ALL ValueStore objects are searchable! If we DON'T want to index something in the future, we will add a "search: false" boolean.
 -->

---

#### Revision 2: Frame Content Extraction (replaces document mapper switch)

**Old plan:** Pure function `extractFrameContent()` with a switch on `frame.type`.
**New plan:** Add `getContentForIndexing()` to the Frame model.

**User's insight:** "Each one of these frames would be a class that inherits from Frame. Each would have a `getContentForIndexing` that expects an array to be returned."

**Current reality:** Frame is a single model class (`Frame extends ModelBase`). There are no frame-type subclasses. Creating subclasses would be a significant refactor.

<!-- 
Let's make sure we add this as a "future-plans" please.
 -->

**Proposed approach:** Add `getContentForIndexing()` directly to the Frame model. It switches on `this.type` internally, but the API is polymorphic. If/when frame subclasses are introduced later, each subclass overrides the method and the switch goes away. This is the minimal step toward the user's design vision.

```javascript
// On Frame model:
getContentForIndexing() {
  let content = this.getContent();
  if (!content)
    return [];

  switch (this.type) {
    case 'user-message':
    case 'message':
    case 'reflection':
      return [
        content.text && { field: 'content_text', value: content.text },
        content.html && { field: 'content_html', value: content.html },
      ].filter(Boolean);

    case 'tool-call':
      return [
        { field: 'content_text', value: `${content.toolName}: ${JSON.stringify(content.arguments || {})}` },
        content.toolName && { field: 'tool_name', value: content.toolName },
      ].filter(Boolean);

    case 'tool-result':
      return [
        { field: 'content_text', value: (typeof content.result === 'string') ? content.result : JSON.stringify(content.result) },
      ];

    case 'tool-error':
    case 'error':
      return [
        { field: 'content_text', value: content.message || content.error || content.text || '' },
      ];

    // ... other types
    default:
      return [
        { field: 'content_text', value: JSON.stringify(content) },
      ];
  }
}
```

<!-- 
Mark this with a comment to be updated in the future when we move to class-based frame system.
 -->

**Returns array** (per user's specification) — each entry is `{ field, value }`. The indexing plugin iterates and populates the Solr document from these entries.

**The separate document mapper module still exists** — but it's thinner. It calls `frame.getContentForIndexing()` and assembles the Solr document structure from the results + metadata fields (id, sessionID, type, etc.).

---

#### Revision 3: Search Results Include Content Previews

**Old plan:** Return only `id` + `doc_type` from search.
**New plan:** Fetch documents from DB, return content previews.

**For both HTTP API and agent tool:**
1. Solr returns matching IDs + doc_types
2. Backend fetches full records from SQLite (Frame or ValueStore by ID)
3. Content is truncated to 1024 chars
4. Response includes `contentSize` (original byte length) so consumers know if content was truncated
5. If truncated, include a flag: `truncated: true`
<!-- 
Let's not have this a flag... let's have it "truncated: [ 0, 12341234 ]" // start byte, end byte (we always truncate the beginning of the content and leave the end)
 -->

**Response shape update:**
```javascript
{
  query:       'hello world',
  resultCount: 42,
  pagination:  { rows: 10, start: 0, total: 42 },
  results: [
    {
      id:          'frm_xxx',
      doc_type:    'frame',
      type:        'message',
      sessionID:   'ses_abc',
      authorType:  'agent',
      timestamp:   1711929600000,
      preview:     'Hello! How can I help you today? I noticed...',
      contentSize: 2048,
      truncated:   true,
    },
    {
      id:          'tl_yyy',
      doc_type:    'value_store',
      type:        'tool_log:shell:execute',
      sessionID:   'ses_abc',
      note:        'ls -la /tmp',
      preview:     'total 48\ndrwxrwxrwt 12 root root...',
      contentSize: 512,
      truncated:   false,
    },
  ],
}
```

**For agents specifically:** Include `contentSize` prominently so the agent knows to chunk-fetch large results. The search tool response should say something like "Result 3: 48KB — use tool_log:get to fetch in chunks."

<!-- 
Yes! Now you are talking!
 -->

---

#### Revision 4: Plural Session IDs + "Archived" Terminology

**Session filter:** `sessionIDs` (plural) accepted as array parameter.
```
POST /api/v2/search
{
  q: "hello",
  sessionIDs: ["ses_abc", "ses_def"],   // optional, plural
  rows: 10
}
```

If `sessionIDs` omitted → search all accessible sessions for the authenticated user.

**Archived terminology:** Replace `deleted` with `archived` throughout the search layer:
- Solr filter: `fq=-archived:true` by default
- Search params can include `includeArchived: true` to override
- Note: the Frame model still uses `deleted` field in SQLite. The Solr document and search API use `archived` as the public-facing term. The mapper translates: `frame.deleted → solrDoc.archived`.

---

#### Revision 5: Singular vs. Plural Naming

User caught that `mapFrameToSolrDocument()` (singular) feeds into `indexDocuments()` (plural). This is because `SolrService.indexDocuments()` already accepts both single documents and arrays (it normalizes internally). The naming is intentional: the service method is plural because it CAN batch. The mapper returns a single document because it maps one frame at a time.

But per the user's "prefer plurality" quirk, we should:
- Rename mapper: `mapFrameToSolrDocuments()` (returns array — future-proofs for frames that may produce multiple Solr docs)
- This aligns with `getContentForIndexing()` also returning an array

---

### Existing Search Infrastructure (Resolved)

Background exploration complete. Summary of what already exists:

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| SearchController | MISSING | n/a | Creating from scratch |
| Search routes | MISSING | n/a | Creating from scratch |
| `tool_log:search` tool | EXISTS | `src/core/internal-plugins/tool-log/index.mjs` | In-JS LIKE filtering on ValueStore. Could be re-backed by Solr later. |
| `tool_log:get` tool | EXISTS | same file | Single entry fetch with content slicing (`content_start`, `content_end`, `content_lines`). This IS the chunk-fetch mechanism. |
| Client search field | EXISTS (broken) | `src/client/components/kikx-sidebar/kikx-sidebar.mjs` | Fully styled, placeholder "Search sessions...", but zero event listeners. Shell waiting to be wired. |
| Solr search plugin | MISSING | n/a | Creating from scratch |

**Key insight:** `tool_log:get` already supports content slicing — agents can chunk-fetch large tool outputs. Our search results should reference this tool in the response when content is truncated, so agents know HOW to get the full content.

**Integration opportunity:** The existing `tool_log:search` currently does in-JS LIKE filtering after loading all entries from SQLite. Once Solr is wired, this tool could be transparently re-backed by Solr for dramatically faster search. Not MVP scope, but a natural follow-up.

<!-- 
Why would you not do this now... this is _literally why_ we are adding SOLR.
 -->

---

### Updated Implementation Order

**Phase 1: Indexer**
1. Add `getContentForIndexing()` to Frame model (TDD)
2. Create document mapper module — thin, calls `getContentForIndexing()` (TDD)
3. Create SolrIndexingPlugin (FrameRouter, best-effort) (TDD)
4. Add ValueStore indexing to ValueStoreService.set() + setSigned() (TDD)
5. Add ValueStore indexing to ToolLogService.storeToolOutput() (TDD)
6. Expand Solr schema if needed for generic ValueStore fields

**Phase 2: Search API**
7. Create SearchController with DB content enrichment (TDD)
8. Register routes (POST /api/v2/search, POST /api/v2/sessions/:sessionID/search)
9. Wire up existing client session search field (if it exists)

**Phase 3: Agent Tool**
10. Create search:query internal plugin (TDD)
11. Include contentSize in results, with chunk-fetch guidance

---

### New Open Question

**ValueStore scope:** You said "index the damn thing, for every ValueStorage item that is saved or updated." Does this mean ALL namespaces (agent_config, session_context, user_settings, tool_log), or just tool_log? Indexing agent configs and user settings might add noise to search results — or it might be exactly what you want for a unified search across everything. What's your call?

<!--
Yes! All things are searchable! Next round please!
 -->

---

## Round 3: Corrections & Final Architecture

### Corrections from User Feedback

#### 1. Mythix ORM HAS Model Lifecycle Hooks

I was wrong. Mythix ORM provides full lifecycle hooks on every model:

| Hook | When | Use |
|------|------|-----|
| `onBeforeCreate(ctx)` | Before INSERT | Validation, defaults |
| `onBeforeUpdate(ctx)` | Before UPDATE | Validation |
| `onBeforeSave(ctx)` | Before INSERT or UPDATE | Calls `onValidate()` |
| `onAfterCreate(ctx)` | After INSERT | Side effects |
| `onAfterUpdate(ctx)` | After UPDATE | Side effects |
| `onAfterSave(ctx)` | After INSERT or UPDATE | Side effects |

Context shape: `{ connection, Model, options }`. Models have `getApplication()` for reaching the app context → SolrService.

**This means Option (c) is viable and is the cleanest approach:** Override `onAfterSave()` on the ValueStore model. ALL write paths are automatically covered — ValueStoreService, ToolLogService, any future direct model usage. Zero hookpoints to maintain.

#### 2. Solr Field Naming: Use Actual ValueStore Fields

I invented `tool_output` — that's not a real field. The actual generic fields on ValueStore are:

| ValueStore Field | Solr Field | Notes |
|-----------------|-----------|-------|
| `id` | `id` | `vs_xxx` |
| `key` | — | Could map to a Solr field if needed |
| `value` | `content_text` | The actual content (JSON string) |
| `note` | `tool_note` | Human-readable summary |
| `type` | `type` | e.g. `tool_log:shell:execute` |
| `namespace` | — | New Solr field needed? |
| `ownerType` | `authorType` | Maps naturally |
| `ownerID` | `authorID` | Maps naturally |
| `scopeID` | `sessionID` | Maps naturally |
| `createdAt` | `timestamp` | |

The Solr schema needs additional fields for ValueStore-specific data: `namespace`, `ownerType`/`ownerID` (if we want to distinguish from frame authorType/authorID).

<!-- 
You AREN'T leave the owner* field scoping up the _caller_, are you? These obviously need to ALWAYS be filled by the server...
 -->

**Schema expansion needed.** We'll need to add ValueStore-specific fields to `solr/kikx/conf/schema.xml`.

#### 3. ALL ValueStore Objects Are Searchable

Confirmed: index EVERY ValueStore record, regardless of namespace. If we need to exclude something in the future, add a `searchable: false` boolean to the ValueStore model (not in MVP).

#### 4. Truncation Format: Byte Range, Not Boolean

Replace `truncated: true/false` with `truncated: [startByte, endByte]` or `null` if not truncated.

Preview shows the BEGINNING of content (position 0 to 1024). `truncated: [0, 1024]` tells the caller "you're seeing bytes 0–1024 of a larger document."

<!-- 
Actually... I was thinking that this would be the range that _was_ truncated... but I guess in this sense a start/end doesn't make sense? 🤔
I like you way of doing this... but maybe "truncated" is the wrong word? Thoughts?
 -->

```javascript
// Not truncated:
{ preview: 'full content here', contentSize: 200, truncated: null }

// Truncated:
{ preview: 'first 1024 chars...', contentSize: 48000, truncated: [0, 1024] }
```

#### 5. Re-back `tool_log:search` with Solr NOW

User correctly called out: "this is _literally why_ we are adding SOLR." The existing `tool_log:search` tool currently does in-JS LIKE filtering after loading ALL entries from SQLite. This should be re-backed by Solr as part of this work, not deferred.

**Implementation:** Modify `src/core/internal-plugins/tool-log/index.mjs` `SearchToolLogTool._execute()` to use SolrService instead of ValueStore query + in-JS filtering. The tool's API (input schema, response shape) stays the same — only the backing store changes.

#### 6. Frame Subclasses: Document as Future Plan

The `getContentForIndexing()` method on the Frame model will include a comment marking it for future refactoring when we move to a class-based frame system. This goes into a "future plans" section in the planning doc.

---

### Final Architecture (Revised)

#### ValueStore Indexing: `onAfterSave()` Hook

**File:** `src/core/models/value-store-model.mjs` (modify existing)

```javascript
async onAfterSave(context) {
  // Best-effort Solr indexing — never throw from here
  try {
    let application = this.getApplication();
    let solrService = application.getContext().getProperty('solrService');
    if (!solrService)
      return;

    let document = {
      id:         this.id,
      doc_type:   'value_store',
      type:       this.type || null,
      sessionID:  this.scopeID || null,
      authorType: this.ownerType || null,
      authorID:   this.ownerID || null,
      note:       this.note || null,
      // `value` field → content_text for full-text search
      content_text: this.value || null,
      timestamp:    this.createdAt ? this.createdAt.getTime() : Date.now(),
      archived:     false,
      hidden:       false,
    };

    await solrService.indexDocuments(document);
  } catch (error) {
    // Best-effort — log and swallow
    console.error('[SolrIndexing] ValueStore index failed:', this.id, error.message);
  }
}
```

**Advantages:**
- ONE hookpoint catches ALL write paths
- Automatic — no code changes needed at any call site
- Best-effort — failures are logged, never thrown
- Lifecycle-correct — runs AFTER the DB write succeeds

**Testing:** Mock `getApplication()` → mock SolrService. Verify `indexDocuments()` called after save. Verify errors swallowed.

---

#### Frame Indexing: FrameRouter Plugin (unchanged)

Still the best approach for frames. FrameRouter provides richer context (session, commit, changes) than `onAfterSave` would. The plugin calls `frame.getContentForIndexing()` to get the content fields.

---

#### Re-backing `tool_log:search` with Solr

**File:** `src/core/internal-plugins/tool-log/index.mjs` (modify existing `SearchToolLogTool`)

**Current behavior:** Queries ValueStore via ORM, loads all matching entries into memory, filters in-JS, slices for pagination.

**New behavior:**
1. Get SolrService from context
2. Build Solr query from input params (query, toolName, sessionID, before/after)
3. Call `solrService.search()` with appropriate filter queries
4. Solr returns matching IDs
5. Fetch full records from ValueStore by ID (for content preview)
6. Return same response shape as before

**Fallback:** If SolrService is unavailable, fall back to current in-JS filtering. This keeps the tool functional even without Solr.

**Filter query mapping:**

| Tool Input | Solr Filter |
|-----------|------------|
| `toolName: "shell:execute"` | `fq=type:tool_log\\:shell\\:execute` |
| `sessionID: "ses_xxx"` | `fq=sessionID:ses_xxx` |
| `before: "2026-03-01"` | `fq=timestamp:[* TO 1709251200000]` |
| `after: "2026-03-01"` | `fq=timestamp:[1709251200000 TO *]` |
| `query: "npm install"` | `q=npm install` (eDisMax on content_text) |

---

### Solr Schema Expansion

Current schema was designed for frames + tool logs. With ALL ValueStore items being indexed, we need additional fields:

**New fields to add to `solr/kikx/conf/schema.xml`:**

```xml
<!-- ValueStore namespace (agent_config, tool_log, session_context, etc.) -->
<field name="namespace" type="string" indexed="true" stored="false" />

<!-- Generic note field (already exists as tool_note — rename or alias) -->
<!-- tool_note → note (it's a generic ValueStore field, not tool-specific) -->
```

**Rename consideration:** `tool_note` and `tool_name` in the current schema are tool-log-specific names. Since we're now indexing ALL ValueStore items, these should be renamed to generic names, or we keep them as-is and accept they're slightly misleading for non-tool-log records.

**Recommendation:** Keep `tool_note` and `tool_name` as-is for now (they're already deployed). Add `namespace` as a new field. The `type` field already handles discrimination. We can rename in a future schema revision.

<!-- 
No, let's not do misleading. Let's rename them. I want a unified and flexible "ValueStore".

We literally have nothing in SOLR right now. This "there already deployed" argument is pretty weak...
 -->

---

### Updated Implementation Order (Final)

**Phase 1: Indexer**
1. Add `getContentForIndexing()` to Frame model — with TODO comment for future class-based refactor (TDD)
2. Create document mapper module — thin, calls `getContentForIndexing()` (TDD)
3. Create SolrIndexingPlugin (FrameRouter, best-effort) (TDD)
4. Add `onAfterSave()` to ValueStore model for Solr indexing (TDD)
5. Add `namespace` field to Solr schema
6. Verification: send a message, check Solr has frame + tool log indexed

**Phase 2: Search API**
7. Create SearchController with DB content enrichment + byte-range truncation (TDD)
8. Register routes (POST /api/v2/search, POST /api/v2/sessions/:sessionID/search)

**Phase 3: Agent Tools**
9. Re-back `tool_log:search` with Solr (fallback to SQLite if Solr unavailable) (TDD)
10. Create `search:query` internal plugin (TDD)
11. Include contentSize + truncated byte range in results

**Phase 4: Client Wiring (can overlap with Phase 2/3)**
12. Wire sidebar search input to `POST /api/v2/search` endpoint

---

### Future Plans (Documented)

| Item | Description | Priority |
|------|------------|----------|
| Frame class hierarchy | Introduce frame-type subclasses (UserMessageFrame, ToolCallFrame, etc.) that override `getContentForIndexing()` | Medium |
| ValueStore `searchable` field | Boolean field to opt-out individual records from Solr indexing | Low |
| Bulk re-indexing script | `scripts/solr-reindex.mjs` for initial population or recovery | Medium |
| Re-back more tools with Solr | `ValueStoreService.search()` → Solr instead of in-JS LIKE | Medium |
| Faceted search API | Expose Solr faceting for search by type, author, date ranges | Low |

---

### Remaining Open Questions

None. All questions from Rounds 1 and 2 have been answered. The plan is ready for implementation on your signal.

<!--
Next round!
 -->

---

## Round 5: Merge content_text and content_html

### content_text vs content_html: No, We Don't Need Both

The only difference between them is the analyzer chain:
- `text_en`: tokenize → stopwords → lowercase → English possessive → Porter stemmer
- `text_html`: HTMLStripCharFilter → same pipeline as `text_en`

`HTMLStripCharFilter` is a **no-op on plain text** — it only strips `<tags>` when they're present. Running plain text through `text_html` produces identical results to `text_en`.

**Decision:** Merge into a single `content` field using the `text_html` type. It handles both cases.

<!-- 
Yes!
 -->

**Updated schema:**

| Field | Type | Stored | Notes |
|-------|------|--------|-------|
| `id` | string | yes | Unique key (frm_xxx, vs_xxx) |
| `doc_type` | string | yes | `frame` or `value_store` |
| `type` | string | no | Frame type or ValueStore type |
| `sessionID` | string | no | Session scope |
| `interactionID` | string | no | Frame-specific |
| `authorType` | string | no | `user`, `agent`, `system` / ownerType |
| `authorID` | string | no | User/agent ID |
| `namespace` | string | no | ValueStore namespace |
| `note` | text_html | no | Human-readable summary (searchable) |
| `content` | text_html | no | All searchable content (plain text or HTML) |
| `timestamp` | plong | no | Milliseconds since epoch |
| `hidden` | boolean | no | Visibility flag |
| `archived` | boolean | no | Soft-delete / archive flag |
| `_text_` | text_en | no | Catch-all copy field |

**Changes from Round 4:**
- `content_text` + `content_html` → merged into single `content` field (type `text_html`)
- `note` type changed from `string` to `text_html` (make it searchable with stemming, not just exact match)
- Copy fields: `content` and `note` both copy into `_text_`

**Impact on `getContentForIndexing()`:** Simpler — returns `{ field: 'content', value: '...' }` instead of deciding between `content_text` and `content_html`. The frame doesn't need to know whether its content is HTML or plain text — the analyzer handles it.

**Impact on `text_en` field type:** Still used for `_text_` catch-all. Can potentially be removed entirely if we switch `_text_` to `text_html` too. But keeping `text_en` for `_text_` is fine — the catch-all doesn't need HTML stripping since the source fields already handle it.

---

### Final Schema (Definitive)

13 fields. Clean, unified, no tool-specific naming.

```xml
<!-- Unique key -->
<field name="id"            type="string"    indexed="true" stored="true" required="true" />
<field name="doc_type"      type="string"    indexed="true" stored="true" />

<!-- Classification -->
<field name="type"          type="string"    indexed="true" stored="false" />
<field name="namespace"     type="string"    indexed="true" stored="false" />

<!-- Ownership & scope -->
<field name="sessionID"     type="string"    indexed="true" stored="false" />
<field name="interactionID" type="string"    indexed="true" stored="false" />
<field name="authorType"    type="string"    indexed="true" stored="false" />
<field name="authorID"      type="string"    indexed="true" stored="false" />

<!-- Searchable content -->
<field name="content"       type="text_html" indexed="true" stored="false" />
<field name="note"          type="text_html" indexed="true" stored="false" />

<!-- Metadata -->
<field name="timestamp"     type="plong"     indexed="true" stored="false" />
<field name="hidden"        type="boolean"   indexed="true" stored="false" />
<field name="archived"      type="boolean"   indexed="true" stored="false" />

<!-- Copy fields → catch-all -->
<copyField source="content" dest="_text_" />
<copyField source="note"    dest="_text_" />
```

---

### Plan Status

4 rounds of feedback fully incorporated. Schema is clean and final. No remaining open questions.

Ready for implementation on your signal.

---

## Round 4: Final Corrections

### 1. Owner Fields: Always Server-Populated

You're right to flag this. To be clear: `authorType` and `authorID` in the Solr index are ALWAYS populated from the MODEL data (server-side), never from API caller input.

- **At index time:** `ValueStore.ownerType` → Solr `authorType`. Comes from the model instance after DB save. The caller can't influence this.
- **At search time:** The server determines accessible sessions from the authenticated user's permissions. Search results are filtered by `sessionID` — the caller never controls `authorType`/`authorID` filtering directly.
- **In the SearchController:** The `authorType` filter (if exposed) would be a convenience filter for the UI ("show only agent messages"), NOT an access control mechanism. Access control is session-scoped.

### 2. Rename "truncated" → "contentRange"

You're right that "truncated" implies what was REMOVED, not what was RETURNED. Better name: `contentRange`.

```javascript
// Full content (not truncated):
{ preview: 'full content here', contentSize: 200, contentRange: null }

// Partial content:
{ preview: 'first 1024 chars...', contentSize: 48000, contentRange: [0, 1024] }
```

`contentRange: [startByte, endByte]` — tells the caller exactly which slice of the original content is in the `preview` field. `null` means the entire content is present. This mirrors HTTP `Content-Range` semantics.

<!-- 
Love it! `contentRange` is perfect!
 -->

### 3. Rename Solr Schema Fields (Clean Slate)

You're absolutely right — the index is empty, zero migration cost. Rename now.

**Field renames:**

| Old Name | New Name | Rationale |
|----------|----------|-----------|
| `tool_note` | `note` | Generic ValueStore field, not tool-specific |
| `tool_name` | (dropped) | Tool name is encoded in `type` field (e.g., `tool_log:shell:execute`). No dedicated field needed. |
| `tool_output` | (was already fictional) | Content goes in `content_text` |

**Final unified Solr schema fields:**

| Field | Type | Stored | Notes |
|-------|------|--------|-------|
| `id` | string | yes | Unique key (frm_xxx, vs_xxx) |
| `doc_type` | string | yes | `frame` or `value_store` |
| `type` | string | no | Frame type or ValueStore type |
| `sessionID` | string | no | Session scope |
| `interactionID` | string | no | Frame-specific |
| `authorType` | string | no | `user`, `agent`, `system` (Frame) or ownerType (ValueStore) |
| `authorID` | string | no | User/agent ID |
| `namespace` | string | no | ValueStore namespace (NEW) |
| `note` | string | no | Human-readable summary (RENAMED from tool_note) |
| `content_text` | text_en | no | Plain text / ValueStore value |
| `content_html` | text_html | no | HTML content (frames only) |
| `timestamp` | plong | no | Milliseconds since epoch |
| `hidden` | boolean | no | Visibility flag |
| `archived` | boolean | no | Soft-delete / archive flag |
| `_text_` | text_en | no | Catch-all copy field |

**Copy field updates:** `note` and `content_text` and `content_html` all copy into `_text_` for broad search.

**What gets dropped from current schema:**
- `tool_note` → renamed to `note`
- `tool_name` → removed entirely
- `tool_output` → removed entirely (was only in the plan, never deployed)

<!-- 
Do we have a need to differentiate between content_text and content_html?
 -->

---

### Plan Status

All feedback incorporated across 4 rounds. No remaining open questions. Architecture is:

1. **Frame indexing:** FrameRouter plugin → `frame.getContentForIndexing()` → SolrService
2. **ValueStore indexing:** `onAfterSave()` model hook → SolrService (catches all write paths)
3. **Search API:** SearchController with DB content enrichment, `contentRange` byte-range, session permission filtering, plural `sessionIDs`
4. **Agent tools:** Re-back `tool_log:search` with Solr + new `search:query` tool
5. **Schema:** Clean, unified field names. `namespace` added. `tool_*` fields renamed/removed.
6. **Client:** Wire existing sidebar search input to search endpoint.

Ready for implementation on your signal.

<!--
I see _some_ testing... but I think the plan for testing could be better, yes?
 -->

---

## Round 6: Comprehensive Test Plan

The test strategy from Round 1 was a surface sketch. Here's the real plan — every code path, failure mode, and edge case.

---

### Test Suite 1: `Frame.getContentForIndexing()` — `spec/core/models/frame-model-indexing-spec.mjs`

**Happy paths (one per frame type):**
- `user-message` with `{ text, html }` → returns `[{ field: 'content', value: text }, { field: 'content', value: html }]` (or combined)
- `user-message` with text only (no html) → returns text content
- `user-message` with html only (no text) → returns html content
- `message` (agent) with `{ text }` → returns text content
- `message` with `{ html }` → returns html content
- `reflection` with `{ text }` → returns text, hidden flag noted
- `tool-call` with `{ toolName, arguments }` → returns serialized tool call
- `tool-result` with `{ result: "string" }` → returns string result
- `tool-result` with `{ result: { object } }` → returns JSON-stringified result
- `tool-error` with `{ message }` → returns error message
- `tool-error` with `{ error }` → returns error text
- `error` with `{ message }` → returns message
- `error` with `{ text }` → returns text
- `permission-denied` with `{ message }` → returns message
- `permission-denied` with `{ reason }` → returns reason
- `stop` frame → returns text/message if present
- `hook-blocked` frame → returns text/message if present
- `tool-activity` with `{ html }` → returns html content

**Null/missing content:**
- `content` is `null` → returns `[]`
- `content` is `undefined` → returns `[]`
- `content` is empty string `""` → returns `[]`
- `content` is `"null"` (string literal) → returns `[]` or handles gracefully

**Malformed content:**
- `content` is a non-JSON string → returns raw string wrapped in content field
- `content` is valid JSON string → parses and extracts correctly
- `content` is already an object (not string) → uses directly
- `content` is a JSON string of a primitive (`"42"`, `"true"`) → handles gracefully
- `content` has unexpected shape for frame type (e.g., `tool-call` without `toolName`) → doesn't throw, returns best-effort

**Edge cases:**
- Frame with unknown `type` (not in the switch) → falls through to default, returns stringified content
- Frame with empty content object `{}` → returns `[]` (no fields to extract)
- Content with very large text (100KB+) → returns it all (truncation is the search layer's job, not the model's)
- Content with HTML entities, nested tags, script tags → returns as-is (Solr's HTMLStripCharFilter handles it)
- Content with Unicode, emoji, RTL text → returned correctly

**Return format:**
- Always returns an array (never null, never a single object)
- Each entry has `{ field, value }` shape
- `value` is always a string (not null, not undefined, not object)

---

### Test Suite 2: Document Mapper — `spec/core/lib/solr-document-mapper-spec.mjs`

**Frame mapping (`mapFrameToSolrDocuments()`):**
- Maps all metadata fields correctly: id, doc_type='frame', type, sessionID, interactionID, authorType, authorID, timestamp
- `hidden: true` → `hidden: true` in Solr doc
- `deleted: true` → `archived: true` in Solr doc (terminology translation)
- `deleted: false` → `archived: false`
- Calls `getContentForIndexing()` and spreads results into Solr doc
- Returns an array (even for single document)

**Frame mapping edge cases:**
- Frame with no sessionID → field omitted or null
- Frame with no authorType/authorID → fields omitted or null
- Frame with no timestamp → uses fallback (Date.now() or null — decide)
- Frame with `groupType === 'phantom'` → returns empty array (skip phantom)
- `getContentForIndexing()` returns empty array → Solr doc has metadata only, no content fields

**ValueStore mapping (via `onAfterSave`):**
- Maps all fields: id, doc_type='value_store', type, namespace, sessionID (from scopeID), authorType (from ownerType), authorID (from ownerID), note, content (from value), timestamp
- `archived: false` and `hidden: false` always (ValueStore has no archive/hidden concept yet)
- Handles null `value` → content field omitted or empty string
- Handles null `note` → note field omitted or null
- Handles null `type` → type field omitted or null
- Handles empty string `scopeID` → sessionID is empty string or null

---

### Test Suite 3: SolrIndexingPlugin — `spec/core/internal-plugins/solr-indexing-spec.mjs`

**Registration:**
- `setup()` calls `registerSelector` with correct selector and plugin class
- `setup()` returns a teardown function (or empty function)

**Happy path:**
- `process()` indexes frame via `solrService.indexDocuments()`
- `process()` calls `next()` after successful indexing
- Solr document contains correct fields from frame

**Best-effort error handling:**
- `solrService.indexDocuments()` throws → error logged, `next()` still called
- `solrService.indexDocuments()` throws SolrError with status 503 → error logged, `next()` still called
- `solrService.indexDocuments()` throws timeout error → error logged, `next()` still called
- `solrService.indexDocuments()` rejects with network error → error logged, `next()` still called
- `frame.getContentForIndexing()` throws → error logged, `next()` still called

**Skip conditions:**
- `solrService` not on context (not configured) → `next()` called immediately, no indexing attempted
- Frame with `groupType === 'phantom'` → `next()` called immediately, no indexing attempted
- `this.context.newFrame` is null/undefined → `next()` called, no crash

**Context access:**
- Plugin correctly reads `context.getProperty('solrService')` (closure-captured global context)
- Plugin correctly reads `this.context.newFrame` (per-routing-cycle context)
- Plugin correctly reads `this.context.session.id` for sessionID

**Chain integrity:**
- `next()` is ALWAYS called exactly once, regardless of success/failure/skip
- `done()` is never called (plugin never terminates the chain)

---

### Test Suite 4: ValueStore `onAfterSave()` — `spec/core/models/value-store-indexing-spec.mjs`

**Happy path:**
- After `ValueStore.create()` → `onAfterSave` fires → `solrService.indexDocuments()` called with correct document
- After `entry.save()` (update) → `onAfterSave` fires → `solrService.indexDocuments()` called
- Solr document has correct field mapping (id, doc_type, type, namespace, etc.)

**Best-effort error handling:**
- `solrService.indexDocuments()` throws → error logged, no exception propagates
- `solrService.indexDocuments()` throws SolrError 503 → error logged, save still succeeds
- `solrService.indexDocuments()` times out → error logged, save still succeeds
- `getApplication()` returns null → no crash, no indexing
- `getApplication().getContext()` throws → no crash, no indexing

**Skip conditions:**
- `solrService` not on context → no indexing, no error
- Application not initialized yet (startup race) → no crash

**Data integrity:**
- Verify the DB write COMPLETED before Solr indexing starts (onAfterSave guarantee)
- Verify Solr document uses the SAVED values (post-DB), not the pre-save values

---

### Test Suite 5: SearchController — `spec/server/controllers/search-controller-spec.mjs`

**Happy path:**
- `POST /api/v2/search` with `{ q: "hello" }` → calls `solrService.search()` → fetches from DB → returns enriched results
- Returns correct response shape: `{ data: { query, resultCount, results, pagination } }`
- Each result has: id, doc_type, type, sessionID, preview, contentSize, contentRange
- `contentRange: null` when content fits in 1024 chars
- `contentRange: [0, 1024]` when content exceeds 1024 chars
- Pagination: `{ rows, start, total }` matches Solr response

**Input validation:**
- Missing `q` → 400
- Empty string `q: ""` → 400
- `rows: 0` → uses default (10)
- `rows: -1` → uses default or 400
- `rows: 999` → capped at 100
- `start: -1` → uses 0 or 400
- `sessionIDs` is a string → coerced to single-element array
- `sessionIDs` is an array → used as-is
- `includeArchived: true` → removes `-archived:true` filter

**Session permission filtering:**
- User with access to sessions A, B → search scoped to `fq=sessionID:(A OR B)`
- User requests `sessionIDs: ["A"]` where they have access → scoped to A only
- User requests `sessionIDs: ["C"]` where they DON'T have access → 403
- User requests `sessionIDs: ["A", "C"]` (mixed access) → either 403 or filters to only A (decide)

**DB content enrichment:**
- Solr returns frame ID → Frame loaded from DB → content preview extracted
- Solr returns ValueStore ID → ValueStore loaded from DB → content preview extracted
- DB record not found (deleted between Solr search and DB fetch) → result excluded from response (no crash)
- Content is null → preview is empty string, contentSize is 0

**Error handling:**
- Solr unavailable → 503 with helpful message ("Search service temporarily unavailable")
- Solr times out → 503
- Solr returns error → 500 with error details
- DB error during content enrichment → 500

**Session-scoped search (`POST /api/v2/sessions/:sessionID/search`):**
- Same as above, but sessionID always from URL path
- User lacks access to the session → 403
- Session doesn't exist → 404

---

### Test Suite 6: `tool_log:search` Solr Re-backing — `spec/core/internal-plugins/tool-log-search-solr-spec.mjs`

**Happy path (Solr available):**
- `query: "npm install"` → Solr search with `q=npm install` → results fetched from DB
- `toolName: "shell:execute"` → Solr filter `fq=type:tool_log:shell:execute`
- `sessionID` → Solr filter `fq=sessionID:...`
- `before`/`after` → Solr timestamp range filters
- `limit` and `offset` → Solr `rows` and `start`
- Response shape matches existing tool_log:search response (backwards compatible)

**Fallback (Solr unavailable):**
- SolrService is null → falls back to existing in-JS filtering
- SolrService.search() throws → falls back to existing in-JS filtering
- Fallback produces same response shape as Solr path

**Edge cases:**
- Empty query (no filters, no search text) → returns recent tool logs
- `toolName` with special chars (colons, wildcards) → properly escaped in Solr query
- `before` and `after` both set → combined timestamp range filter
- `limit: 0` → returns empty results
- `limit: 101` → capped at 100

---

### Test Suite 7: `search:query` Agent Tool — `spec/core/internal-plugins/search-tool-spec.mjs`

**Happy path:**
- `{ query: "hello" }` → calls SolrService.search() → returns formatted results
- Results include: id, doc_type, type, preview, contentSize, contentRange
- Large content truncated with `contentRange: [0, 1024]` and `contentSize` set
- Result message includes chunk-fetch hint when truncated

**Input validation:**
- Missing `query` → throws Error
- `query` is not a string → throws Error
- `rows: 100` → capped at 50 (agent cap)
- `rows: -1` → uses default (10)
- `docType` filter applied correctly
- `frameType` filter applied correctly

**Session scoping:**
- Default sessionID = `_sessionID` from augmented args
- Explicit `sessionID` parameter overrides default
- Agent can only search sessions it has access to

**Error handling:**
- SolrService throws → descriptive error message for agent
- SolrService times out → descriptive error message
- DB enrichment fails for some results → partial results returned (not total failure)

---

### Cross-Cutting Test Concerns

**Concurrency:**
- Multiple frames indexed simultaneously → no corruption, no lost updates
- Solr indexing doesn't block frame creation pipeline

**Performance guards:**
- Large batch of frames committed at once → indexing doesn't OOM
- Search with thousands of results → pagination works correctly

**Integration tests (E2E with real Solr):**
- Send a message → verify frame appears in Solr index → search finds it
- Store a tool log → verify it appears in Solr → tool_log:search finds it
- Archive a session → verify frames marked `archived: true` in Solr → default search excludes them → `includeArchived: true` search finds them
- Delete a ValueStore entry → verify Solr index is updated (or document about how deletions are handled)

---

### Test File Summary

| Test File | Component | Estimated Tests |
|-----------|-----------|----------------|
| `spec/core/models/frame-model-indexing-spec.mjs` | `Frame.getContentForIndexing()` | ~25 |
| `spec/core/lib/solr-document-mapper-spec.mjs` | Document mapper functions | ~20 |
| `spec/core/internal-plugins/solr-indexing-spec.mjs` | SolrIndexingPlugin (FrameRouter) | ~15 |
| `spec/core/models/value-store-indexing-spec.mjs` | ValueStore `onAfterSave()` | ~12 |
| `spec/server/controllers/search-controller-spec.mjs` | SearchController | ~25 |
| `spec/core/internal-plugins/tool-log-search-solr-spec.mjs` | tool_log:search Solr re-backing | ~15 |
| `spec/core/internal-plugins/search-tool-spec.mjs` | search:query agent tool | ~15 |
| **Total** | | **~127 tests** |

---

## Round 7: Explicit Sad Paths

Fair call — I scattered error tests around but never organized them as proper sad-path counterparts to each happy path. Here they are, suite by suite.

---

### Suite 1 Sad Paths: `Frame.getContentForIndexing()`

**Content parsing failures:**
- `content` is `"{invalid json"` (broken JSON string) → doesn't throw, returns raw string as content
- `content` is `"<html><body>test</body></html>"` (HTML string, not JSON) → treated as raw text
- `content` is a number (`42`) → doesn't throw, returns stringified or empty
- `content` is a boolean (`true`) → doesn't throw
- `content` is an array (`[1, 2, 3]`) → doesn't throw, returns stringified

**Type-specific failures:**
- `tool-call` with `arguments` that throws on `JSON.stringify()` (circular reference) → doesn't throw, returns fallback
- `tool-result` with `result` that is `undefined` → returns empty/null content, not "undefined" string
- `tool-error` with none of `message`, `error`, or `text` present → returns empty content
- `permission-denied` with neither `message` nor `reason` → returns empty content

**State corruption:**
- `this.type` is `null` → falls to default case, doesn't throw
- `this.type` is `undefined` → falls to default case
- `this.type` is an empty string → falls to default case
- `getContent()` itself throws (corrupt internal state) → `getContentForIndexing()` catches and returns `[]`

---

### Suite 2 Sad Paths: Document Mapper

**Frame mapping failures:**
- Frame instance is `null` → returns `[]`, doesn't throw
- Frame has no `id` → returns doc without id (or throws — decide: id is required for Solr)
- `getContentForIndexing()` returns non-array (string, object, null) → coerced to array or handled gracefully
- `getContentForIndexing()` returns entries with missing `field` or `value` → skipped, not indexed
- `getContentForIndexing()` returns entries where `value` is not a string (number, object, null) → coerced or skipped

**ValueStore mapping failures:**
- ValueStore record has `null` for every field → returns doc with only id + doc_type
- `createdAt` is null → timestamp defaults to `Date.now()` or 0
- `createdAt` is invalid Date → handled gracefully
- `value` is extremely large (10MB JSON string) → passed through to Solr (Solr's problem to handle)
- `value` is binary-looking garbage → passed as-is to content field

---

### Suite 3 Sad Paths: SolrIndexingPlugin

**Solr service failures (per HTTP status):**
- SolrError 400 (bad request — malformed document) → logged, chain continues
- SolrError 408 (timeout) → logged, chain continues
- SolrError 429 (rate limited) → logged, chain continues
- SolrError 500 (internal server error) → logged, chain continues
- SolrError 503 (service unavailable) → logged, chain continues
- Non-SolrError (TypeError, RangeError, etc.) → logged, chain continues

**Context corruption:**
- `this.context` is null → doesn't throw, calls next with null
- `this.context.newFrame` is null → skip, call next
- `this.context.session` is null → sessionID is null, indexing proceeds (Solr accepts null)
- `this.context.session.id` is undefined → sessionID is undefined

**Mapper returns bad data:**
- `mapFrameToSolrDocuments()` returns `null` → skip indexing, call next
- `mapFrameToSolrDocuments()` returns empty array `[]` → no indexing, call next
- `mapFrameToSolrDocuments()` throws → caught, logged, call next

---

### Suite 4 Sad Paths: ValueStore `onAfterSave()`

**Application context unavailable:**
- `this.getApplication()` returns `null` → no crash, silent no-op
- `this.getApplication()` throws → no crash, silent no-op
- Application exists but context has no `solrService` property → silent no-op
- Application exists but `getContext()` returns null → no crash

**Solr failures:**
- SolrError 400 → logged, DB save unaffected
- SolrError 408 (timeout) → logged, DB save unaffected
- SolrError 429 (rate limited) → logged, DB save unaffected
- SolrError 503 (unavailable) → logged, DB save unaffected
- Network error (ECONNREFUSED — Solr not running) → logged, DB save unaffected
- DNS resolution failure → logged, DB save unaffected

**Critical guarantee:**
- **DB save NEVER fails because of Solr.** Every sad path must verify the save succeeded regardless of what Solr does. This is the #1 invariant of the entire indexing system.

---

### Suite 5 Sad Paths: SearchController

**Solr service failures:**
- Solr returns 0 results → `{ data: { resultCount: 0, results: [] } }` (not an error)
- Solr connection refused → 503 "Search service temporarily unavailable"
- Solr times out (15s) → 503 with timeout message
- Solr returns malformed JSON → 500
- Solr returns HTTP 500 → 500 with Solr error details
- Solr returns HTTP 429 (rate limited) → 503 "Search service busy, try again"

**DB enrichment failures:**
- Frame ID from Solr doesn't exist in DB (race: deleted after indexing) → result silently excluded
- ValueStore ID from Solr doesn't exist in DB → result silently excluded
- DB connection error during enrichment → 500
- Partial DB failure (3 of 10 records fail to load) → return the 7 that succeeded, exclude the 3 failed
- All DB records fail to load → empty results (not 500)

**Auth failures:**
- No auth token → 401
- Expired auth token → 401
- Valid token but user has access to ZERO sessions → empty results (not error)
- Valid token but user account deleted/disabled → 403

**Malformed request bodies:**
- Body is not JSON → 400
- Body is null → 400 (missing q)
- Body is array instead of object → 400
- `q` is a number → 400
- `q` is an object → 400
- `sessionIDs` contains non-string elements → 400 or coerce
- `sessionIDs` is empty array `[]` → search all accessible sessions (same as omitted)

---

### Suite 6 Sad Paths: `tool_log:search` Re-backing

**Solr path failures → graceful fallback:**
- SolrService.search() throws SolrError → fall back to SQLite, log warning
- SolrService.search() throws timeout → fall back to SQLite, log warning
- SolrService.search() returns 0 results but SQLite has matches (index lag) → Solr result returned (caller gets 0), no automatic fallback for "fewer results" — only for errors
- Solr returns IDs that don't exist in ValueStore (stale index) → those results excluded

**Fallback path failures:**
- Both Solr AND SQLite fail → throw error to agent (tool execution failure)
- SQLite returns results but content parsing fails → results returned without content preview

**Input edge cases:**
- `toolName: "*"` (wildcard) → handled correctly or rejected
- `before` is not a valid ISO date string → 400 or ignored
- `after` is in the future → valid (returns nothing)
- `before` is before `after` (impossible range) → returns empty results
- `query` contains Solr special chars (`+`, `-`, `&&`, `||`, `!`, `(`, `)`, `{`, `}`, `[`, `]`, `^`, `"`, `~`, `*`, `?`, `:`, `\`) → properly escaped

---

### Suite 7 Sad Paths: `search:query` Agent Tool

**Solr failures:**
- SolrService not on context → throw descriptive error ("Search is not configured")
- SolrService.search() throws → throw descriptive error with original message
- SolrService.search() times out → throw with timeout message

**DB enrichment failures:**
- All result IDs missing from DB → return `{ resultCount: N, results: [], message: "Results found but content unavailable" }`
- Some results enrichable, some not → return partial results with count discrepancy noted

**Agent context issues:**
- `_sessionID` not in augmented args → throw or search all accessible sessions
- `_agent` not in augmented args → throw ("Agent context required")
- Agent has no session access (orphaned agent) → empty results

**Adversarial input:**
- `query` is a Solr injection attempt (`*:* AND id:secret`) → eDisMax prevents injection (test that it does)
- `query` is extremely long (10KB string) → handled gracefully (Solr may reject, we catch the error)
- `docType` is not "frame" or "value_store" → ignored or 400
- `frameType` doesn't match any known type → valid (returns 0 results)

---

### Updated Test Counts

| Test File | Happy | Sad | Edge | Total |
|-----------|-------|-----|------|-------|
| `frame-model-indexing-spec.mjs` | 18 | 12 | 8 | ~38 |
| `solr-document-mapper-spec.mjs` | 12 | 10 | 5 | ~27 |
| `solr-indexing-spec.mjs` | 5 | 12 | 5 | ~22 |
| `value-store-indexing-spec.mjs` | 4 | 12 | 3 | ~19 |
| `search-controller-spec.mjs` | 8 | 20 | 8 | ~36 |
| `tool-log-search-solr-spec.mjs` | 6 | 10 | 6 | ~22 |
| `search-tool-spec.mjs` | 5 | 10 | 5 | ~20 |
| **Total** | **58** | **86** | **40** | **~184** |

Sad paths outnumber happy paths. As they should.