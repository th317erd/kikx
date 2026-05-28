# Node.js and Apache Solr: Client Libraries, Patterns, and Best Practices

> **Target audience:** Node.js developers integrating with Apache Solr 8.x / 9.x.
> **Node.js version:** 20+ (uses native `fetch`, `AbortSignal.timeout`, `worker_threads`).
> **Last reviewed:** 2026-03

---

## Table of Contents

1. [Library Landscape](#1-library-landscape)
2. [Recommended Approach](#2-recommended-approach)
3. [Core Operations with Code Examples](#3-core-operations-with-code-examples)
   - [Connecting to Solr](#31-connecting-to-solr)
   - [Adding and Updating Documents](#32-adding-and-updating-documents)
   - [Committing](#33-committing)
   - [Deleting Documents](#34-deleting-documents)
   - [Basic Search Queries](#35-basic-search-queries)
   - [Faceting](#36-faceting)
   - [Highlighting](#37-highlighting)
   - [Spell Check and Suggest](#38-spell-check-and-suggest)
   - [Cursor-Based Streaming Pagination](#39-cursor-based-streaming-pagination)
4. [Error Handling and Resilience](#4-error-handling-and-resilience)
5. [Indexing Pipeline Patterns](#5-indexing-pipeline-patterns)

---

## 1. Library Landscape

### 1.1 `solr-client` (npm: `solr-client`)

**Repository:** [lbdremy/solr-node-client](https://github.com/lbdremy/solr-node-client)
**Latest version:** `0.10.0-rc10`
**Last published:** ~2022 (approximately 4 years old as of 2026)
**Weekly downloads:** ~6,900
**TypeScript types:** `@types/solr-client` (0.7.9, also stale)

This is the most widely used Solr client in the Node.js ecosystem, though its maintenance status is concerning. The library provides a rich feature set: query building, faceting, MoreLikeThis, highlighting, grouping/field collapsing, soft commit, real-time get, and arbitrary search handlers.

**API style:** Callback-first with promise support bolted on. The query builder uses a fluent chaining API.

```js
// CommonJS — this is the only way it works cleanly
const solr = require('solr-client');
const client = solr.createClient({ host: 'localhost', port: 8983, core: 'mycore' });

const query = client.query()
  .q('nodejs')
  .fl(['id', 'title', 'score'])
  .rows(10)
  .start(0);

client.search(query, (err, result) => {
  if (err) throw err;
  console.log(result.response.docs);
});
```

**Pros:**
- Most feature-complete Node.js Solr library available
- Covers facets, highlighting, MLT, grouping, soft commit, ping, optimize
- Decently documented
- Largest installed base — most Stack Overflow answers target it

**Cons:**
- Effectively unmaintained (last release ~2022, 60+ open GitHub issues)
- CommonJS only — no native ESM support
- Targets Solr 3–8; officially untested against Solr 9+
- Callback-first API requires wrapping for modern async/await flows
- No built-in TypeScript generics for document types
- No support for Solr's v2 API or JSON Facet API

---

### 1.2 `solr-node` (npm: `solr-node`)

**Repository:** [godong9/solr-node](https://github.com/godong9/solr-node)

This package's README explicitly states: **"NO LONGER MAINTAINED."** It has 25 stars, 9 open issues, and has not seen a commit since 2016. Do not use it for new projects.

---

### 1.3 Other Notable Packages

**`solr` (npm: `solr`)** — Low-level, last published 11 years ago. Dead.

**`solrjs` (github: dmachi/solrjs)** — Minimal client with RQL query generation. Niche and unmaintained.

**`node-solr-smart-client` (npm: `node-solr-smart-client`)** — A thin wrapper around `solr-client` that adds ZooKeeper-based node discovery. Unmaintained.

**`feathers-solr`** — A [FeathersJS](https://github.com/sajov/feathers-solr) adapter for Solr. Only useful if you are already in the Feathers ecosystem.

**`@mavenomics/solr`** — Not a general-purpose client. Tied to the MavenOmics analytics platform. Not relevant for general use.

None of these packages have seen meaningful maintenance since 2022 or earlier. The Node.js Solr library ecosystem is, frankly, in a poor state.

---

### 1.4 SolrJ (Java) — Context Only

SolrJ is the official Apache-maintained Java client. It is the only client with:
- First-class SolrCloud awareness (ZooKeeper-based smart routing via `CloudSolrClient`)
- Concurrent batch indexing (`ConcurrentUpdateSolrClient`)
- Full support for every Solr API feature
- Active maintenance aligned with Solr releases

If you are in a polyglot environment and performance at scale is critical, running a lightweight Java indexing sidecar (a small Spring Boot or plain-Java service) driven by your Node.js application via an internal HTTP or message queue interface is a legitimate and well-proven architecture. It is not mentioned further in this document.

---

### 1.5 Direct HTTP via `fetch` / `axios` / `got`

Solr's entire API is a JSON-over-HTTP REST interface. Everything `solr-client` does, you can do with a plain HTTP call. The v2 API (available since Solr 6, stabilized in Solr 9) is particularly clean.

**When raw HTTP is better than a library:**

- Your Node.js runtime is ESM-first (`"type": "module"` in `package.json`) — libraries are CJS-only
- You need Solr 9+ features: JSON Facet API, v2 API endpoints, streaming expressions
- You want full TypeScript control over request/response shapes
- Your use case is simple (search + index only, no complex query building)
- You want zero runtime dependencies in your service

**When a library adds value:**

- You are building complex multi-parameter queries with many optional clauses and the fluent builder reduces boilerplate
- You need to support a legacy Solr 7 or 8 setup and want battle-tested parameter encoding
- You are inheriting a codebase already using `solr-client`

For new projects in 2025–2026, **raw HTTP with native `fetch` is the pragmatic choice.** The Solr HTTP API is stable, well-documented, and requires no serialization magic. You avoid a dependency on an unmaintained library.

---

## 2. Recommended Approach

### 2.1 Honest Assessment (2025–2026)

| Package | Status | Verdict |
|---|---|---|
| `solr-client` | Stale (~2022), CJS-only | Use only if inheriting existing code or needing complex query builder |
| `solr-node` | Explicitly abandoned | Do not use |
| Raw HTTP (`fetch`) | Native, actively maintained | **Recommended for new projects** |

**Recommended approach:** Write a thin, project-specific Solr client module using native Node.js `fetch`. This gives you ESM compatibility, full TypeScript support, access to every Solr API feature, zero transitive dependencies, and control over retry/timeout logic.

The examples in this document primarily use raw `fetch` for this reason, with `solr-client` examples shown where the library provides genuine value.

---

### 2.2 ESM vs. CJS Compatibility Issues

`solr-client` is a CommonJS package. In a project with `"type": "module"`, importing it requires a workaround:

```js
// In an ESM project — CJS interop via createRequire
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const solr = require('solr-client'); // works, but awkward
```

Node.js 20 (with the `--experimental-require-module` flag, stabilized in Node 22) allows `require()` of ESM packages, but the reverse — a CJS package using ESM features natively — is not possible. `solr-client` cannot use `import` internally.

The `@types/solr-client` types are also stale and do not cover the full API surface. For TypeScript projects, you will end up writing your own type declarations anyway.

**Bottom line:** If your project is ESM-first, skip `solr-client` and write your own thin HTTP client. It will take less time than fighting the CJS/ESM boundary.

---

## 3. Core Operations with Code Examples

The following examples assume you build a thin wrapper module. This pattern is used throughout:

```js
// solr.mjs — a minimal Solr HTTP client for your project
const BASE = process.env.SOLR_URL ?? 'http://localhost:8983/solr';
const CORE = process.env.SOLR_CORE ?? 'mycore';

export async function solrRequest(path, { method = 'GET', body, signal, params } = {}) {
  const url = new URL(`${BASE}/${CORE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach(val => url.searchParams.append(k, val));
      else url.searchParams.set(k, String(v));
    }
  }
  url.searchParams.set('wt', 'json');

  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw Object.assign(new Error(`Solr ${method} ${path} → HTTP ${res.status}`), {
      status: res.status,
      body: text,
    });
  }

  return res.json();
}
```

---

### 3.1 Connecting to Solr

#### Single Node

No persistent connection is needed. HTTP is stateless. The "connection" is simply the base URL:

```js
// solr.mjs
export const SOLR_BASE = process.env.SOLR_URL ?? 'http://localhost:8983/solr';
export const SOLR_CORE = process.env.SOLR_CORE ?? 'mycore';

// Health check
export async function ping() {
  const data = await solrRequest('/admin/ping', {
    signal: AbortSignal.timeout(5_000),
  });
  if (data.status !== 'OK') throw new Error(`Solr ping failed: ${data.status}`);
  return true;
}
```

#### SolrCloud with ZooKeeper

Node.js has no native ZooKeeper client that integrates with Solr's cluster state. The production-grade options are:

**Option A: External load balancer (recommended)**
Put Nginx, HAProxy, or a cloud load balancer in front of your Solr nodes. Your Node.js code talks to a single VIP. This is the simplest and most operationally sound approach.

```nginx
# nginx.conf snippet
upstream solr_cluster {
    least_conn;
    server solr1:8983;
    server solr2:8983;
    server solr3:8983;
    keepalive 32;
}
```

**Option B: Manual round-robin in Node.js**
For development or small clusters, implement simple round-robin without ZooKeeper awareness:

```js
// solr-cloud.mjs
const NODES = (process.env.SOLR_NODES ?? 'http://localhost:8983').split(',');
let nodeIndex = 0;

function nextNode() {
  const node = NODES[nodeIndex % NODES.length];
  nodeIndex++;
  return node;
}

export async function solrCloudRequest(core, path, options = {}) {
  const node = nextNode();
  const url = new URL(`${node}/solr/${core}${path}`);
  // ... same pattern as solrRequest above
}
```

**Option C: Use the `shards` parameter for distributed queries**
Solr itself handles shard routing for reads. Pass `shards` to enumerate replicas:

```js
// Distributed query across all shards
await solrRequest('/select', {
  params: {
    q: 'nodejs',
    shards: 'solr1:8983/solr/mycore,solr2:8983/solr/mycore',
    rows: 10,
  },
});
```

For writes, any node in a SolrCloud cluster will forward the document to the correct shard leader, so round-robin write distribution is safe.

---

### 3.2 Adding and Updating Documents

Solr's update endpoint accepts JSON arrays. Single and batch updates use the same endpoint.

```js
// add-documents.mjs
import { solrRequest } from './solr.mjs';

// Add a single document
export async function addDocument(doc) {
  return solrRequest('/update', {
    method: 'POST',
    body: [doc],
    params: { commit: 'true' }, // or omit and commit separately
  });
}

// Add a batch of documents
export async function addDocuments(docs, { commit = false, softCommit = false } = {}) {
  const params = {};
  if (commit) params.commit = 'true';
  if (softCommit) params.softCommit = 'true';

  return solrRequest('/update', {
    method: 'POST',
    body: docs,
    params,
  });
}

// Example usage
await addDocuments([
  { id: 'doc-1', title: 'Node.js Guide', body: 'Learn Node.js', tags: ['node', 'javascript'] },
  { id: 'doc-2', title: 'Solr Internals', body: 'How Solr works', tags: ['solr', 'search'] },
], { softCommit: true });
```

**Atomic updates** (update a single field without re-indexing the whole document):

```js
// Atomic partial update using the "set" modifier
await solrRequest('/update', {
  method: 'POST',
  body: [
    {
      id: 'doc-1',            // uniqueKey is always required
      title: { set: 'Updated Node.js Guide' },
      views: { inc: 1 },      // atomic increment
      tags: { add: 'updated' }, // atomic add to multivalue field
    },
  ],
});
```

---

### 3.3 Committing

Solr does not make documents searchable until they are committed. Understanding the commit modes is critical for write performance vs. freshness.

| Mode | Speed | Durability | Use case |
|---|---|---|---|
| Hard commit (`commit=true`) | Slowest | Fsync to disk | End of bulk load, critical data |
| Soft commit (`softCommit=true`) | Fast | In-memory only (tlog for crash recovery) | Near-real-time search (NRT) |
| `autoCommit` (solrconfig.xml) | Automatic | Configurable | Production default |
| `autoSoftCommit` (solrconfig.xml) | Automatic | In-memory | NRT freshness |

```js
// Hard commit — blocks until segments are flushed to disk
export async function hardCommit() {
  return solrRequest('/update', {
    method: 'POST',
    body: { commit: {} },
  });
}

// Soft commit — makes documents visible without fsync
export async function softCommit() {
  return solrRequest('/update', {
    method: 'POST',
    body: { softCommit: true },
  });
}

// Optimize — merges segments, expensive, use sparingly (e.g. after full re-index)
export async function optimize() {
  return solrRequest('/update', {
    method: 'POST',
    body: { optimize: { maxSegments: 1 } },
  });
}
```

**Recommended solrconfig.xml settings for production (NRT):**
```xml
<autoCommit>
  <maxTime>60000</maxTime>     <!-- hard commit every 60s -->
  <openSearcher>false</openSearcher>
</autoCommit>
<autoSoftCommit>
  <maxTime>1000</maxTime>      <!-- soft commit every 1s for NRT -->
</autoSoftCommit>
```

With this configuration, you rarely need to call commit explicitly from application code. Call hard commit explicitly only after a bulk re-index completes.

---

### 3.4 Deleting Documents

```js
// Delete by ID
export async function deleteById(id) {
  return solrRequest('/update', {
    method: 'POST',
    body: { delete: { id } },
    params: { commit: 'true' },
  });
}

// Delete multiple IDs
export async function deleteByIds(ids) {
  return solrRequest('/update', {
    method: 'POST',
    body: { delete: ids.map(id => ({ id })) },
  });
}

// Delete by query
export async function deleteByQuery(query) {
  return solrRequest('/update', {
    method: 'POST',
    body: { delete: { query } },
    params: { commit: 'true' },
  });
}

// Delete all documents (use with care)
export async function deleteAll() {
  return deleteByQuery('*:*');
}

// Example: delete stale documents older than 30 days
await deleteByQuery('created_at:[* TO NOW-30DAY]');
```

---

### 3.5 Basic Search Queries

```js
// search.mjs
import { solrRequest } from './solr.mjs';

/**
 * @param {object} options
 * @param {string} options.q          - Main query string
 * @param {string[]} [options.fq]     - Filter queries (cached separately)
 * @param {string[]} [options.fl]     - Fields to return
 * @param {number} [options.rows]     - Documents per page
 * @param {number} [options.start]    - Offset for pagination
 * @param {string} [options.sort]     - e.g. "score desc,id asc"
 */
export async function search({ q = '*:*', fq = [], fl, rows = 10, start = 0, sort } = {}) {
  const params = { q, rows: String(rows), start: String(start) };
  if (fq.length) params.fq = fq;          // solrRequest appends multiple values
  if (fl) params.fl = fl.join(',');
  if (sort) params.sort = sort;

  const data = await solrRequest('/select', { params });
  return {
    numFound: data.response.numFound,
    start: data.response.start,
    docs: data.response.docs,
  };
}

// Example
const results = await search({
  q: 'nodejs solr',
  fq: ['status:published', 'year:[2020 TO *]'],
  fl: ['id', 'title', 'score'],
  rows: 20,
  sort: 'score desc',
});
console.log(`Found ${results.numFound} docs`);
```

---

### 3.6 Faceting

Solr has two faceting systems:
- **Classic faceting** — `facet=true&facet.field=category` (request parameters)
- **JSON Facet API** — structured JSON in the request body (Solr 5.1+, preferred for complex facets)

```js
// Classic field facets
export async function searchWithFacets({ q, fq = [], facetFields = [], facetQueries = [] }) {
  const params = {
    q,
    fq,
    facet: 'true',
    'facet.field': facetFields,
    'facet.query': facetQueries,
    'facet.mincount': '1',
    rows: '0',           // set to 0 if you only want facets, not docs
  };

  const data = await solrRequest('/select', { params });
  return data.facet_counts;
}

// JSON Facet API (recommended for complex facets — Solr 6+)
export async function searchWithJsonFacets({ q, fq = [], facets }) {
  // facets is a plain JS object matching the JSON Facet API schema
  const params = { q, fq, rows: '0' };

  const data = await solrRequest('/query', {
    method: 'POST',
    body: { query: q, filter: fq, limit: 0, facet: facets },
  });
  return data.facets;
}

// Example: nested facets with stats
const facetResult = await searchWithJsonFacets({
  q: '*:*',
  fq: ['status:published'],
  facets: {
    // Terms facet: top 10 categories
    categories: {
      type: 'terms',
      field: 'category',
      limit: 10,
      facet: {
        // Nested stats for each category bucket
        avg_price: 'avg(price)',
        total_sales: 'sum(sales)',
      },
    },
    // Range facet: price histogram
    price_ranges: {
      type: 'range',
      field: 'price',
      start: 0,
      end: 1000,
      gap: 100,
    },
  },
});

console.log(facetResult.categories.buckets);
// [{ val: 'electronics', count: 234, avg_price: 349.99, total_sales: 81906 }, ...]
```

---

### 3.7 Highlighting

```js
export async function searchWithHighlighting({ q, fl = ['*'], hlFields, snippets = 1, fragsize = 200 }) {
  const params = {
    q,
    fl: fl.join(','),
    hl: 'true',
    'hl.fl': (hlFields ?? fl).join(','),
    'hl.snippets': String(snippets),
    'hl.fragsize': String(fragsize),
    'hl.simple.pre': '<em>',       // wrap matched terms in <em>
    'hl.simple.post': '</em>',
    'hl.method': 'unified',        // unified highlighter (Solr 6+, recommended)
  };

  const data = await solrRequest('/select', { params });

  // Merge highlights into docs for convenience
  const highlighting = data.highlighting ?? {};
  const docs = data.response.docs.map(doc => ({
    ...doc,
    _highlights: highlighting[doc.id] ?? {},
  }));

  return { numFound: data.response.numFound, docs };
}

// Example usage
const results = await searchWithHighlighting({
  q: 'machine learning',
  fl: ['id', 'title', 'body'],
  hlFields: ['title', 'body'],
  snippets: 3,
  fragsize: 150,
});

for (const doc of results.docs) {
  console.log(doc.title);
  console.log(doc._highlights.body?.join(' ... ')); // highlighted snippets
}
```

---

### 3.8 Spell Check and Suggest

These require the `SpellCheckComponent` or `SuggestComponent` to be configured in `solrconfig.xml`. Once configured, calling them from Node.js is a plain HTTP GET.

```js
// Spellcheck — requires spellcheck component configured in solrconfig.xml
export async function spellcheck({ q, count = 5 }) {
  const params = {
    q,
    spellcheck: 'true',
    'spellcheck.count': String(count),
    'spellcheck.collate': 'true',     // return a "did you mean" correction
    'spellcheck.maxCollations': '3',
    rows: '0',
  };
  const data = await solrRequest('/spell', { params });
  return data.spellcheck;
}

// Suggest — requires suggest component configured in solrconfig.xml
export async function suggest({ q, dictionary = 'mySuggester', count = 10 }) {
  const params = {
    'suggest.q': q,
    'suggest.dictionary': dictionary,
    'suggest.count': String(count),
    suggest: 'true',
  };
  const data = await solrRequest('/suggest', { params });

  // Response shape: data.suggest[dictionary][q].suggestions
  return data.suggest?.[dictionary]?.[q]?.suggestions ?? [];
}

// Example: autocomplete
const suggestions = await suggest({ q: 'node' });
console.log(suggestions.map(s => s.term));
// ['nodejs', 'node.js guide', 'node modules', ...]
```

---

### 3.9 Cursor-Based Streaming Pagination

Standard `start`/`rows` pagination degrades severely for deep pages because Solr must score and sort all preceding documents on every request. For exporting large result sets, use `cursorMark`.

**Requirements:**
- The `sort` parameter **must** include the `uniqueKey` field (e.g., `id asc`).
- The `start` parameter must be omitted or set to `0`.
- Do not use date math functions involving `NOW` in the sort (values must be stable across requests).

```js
// cursor-stream.mjs
import { solrRequest } from './solr.mjs';

/**
 * Async generator that streams all matching documents using cursorMark.
 * Never loads more than `batchSize` documents into memory at once.
 *
 * @param {object} options
 * @param {string} options.q
 * @param {string[]} [options.fq]
 * @param {string[]} [options.fl]
 * @param {string} options.sort   - MUST include uniqueKey, e.g. "score desc,id asc"
 * @param {number} [options.batchSize]
 */
export async function* cursorStream({ q = '*:*', fq = [], fl, sort = 'id asc', batchSize = 500 } = {}) {
  let cursorMark = '*';
  let fetched = 0;

  while (true) {
    const params = {
      q,
      fq,
      sort,
      rows: String(batchSize),
      cursorMark,
    };
    if (fl) params.fl = fl.join(',');

    const data = await solrRequest('/select', { params });
    const docs = data.response.docs;
    const nextCursor = data.nextCursorMark;

    if (docs.length === 0) break;

    for (const doc of docs) {
      yield doc;
    }

    fetched += docs.length;

    // Termination condition: cursor didn't advance (exhausted)
    if (nextCursor === cursorMark) break;

    cursorMark = nextCursor;
  }
}

// Usage: export all published documents without OOM
async function exportAll(outputStream) {
  let count = 0;
  for await (const doc of cursorStream({
    q: 'status:published',
    fl: ['id', 'title', 'body', 'created_at'],
    sort: 'created_at desc, id asc',
    batchSize: 1000,
  })) {
    outputStream.write(JSON.stringify(doc) + '\n');
    count++;
    if (count % 10_000 === 0) console.log(`Exported ${count} documents...`);
  }
  return count;
}
```

**Memory profile:** With `batchSize = 1000`, at most 1000 documents are in memory at any given time regardless of total result set size. For a 10 million document export this is essential.

---

## 4. Error Handling and Resilience

### 4.1 Retry Logic with Exponential Backoff

Only retry on transient errors: network failures, `429 Too Many Requests`, `503 Service Unavailable`, and `504 Gateway Timeout`. Do NOT retry `400 Bad Request` (your query is malformed) or `404 Not Found`.

```js
// retry.mjs
const RETRYABLE_STATUS = new Set([429, 503, 504]);

/**
 * Retry a function with exponential backoff and jitter.
 * @param {() => Promise<T>} fn
 * @param {object} opts
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.baseDelayMs]
 * @param {number} [opts.maxDelayMs]
 */
export async function withRetry(fn, { maxAttempts = 4, baseDelayMs = 200, maxDelayMs = 10_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Do not retry client errors or non-retryable statuses
      if (err.status && !RETRYABLE_STATUS.has(err.status)) throw err;
      if (err.name === 'AbortError') throw err;  // timeout — propagate immediately

      if (attempt + 1 >= maxAttempts) break;

      // Exponential backoff with full jitter
      const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = Math.random() * exp;
      const delay = Math.floor(jitter);
      console.warn(`Solr request failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// Usage
const results = await withRetry(
  () => search({ q: 'nodejs', rows: 10 }),
  { maxAttempts: 3, baseDelayMs: 500 },
);
```

---

### 4.2 Timeouts with AbortSignal

Node.js 20+ has `AbortSignal.timeout()` built in — no library needed.

```js
// Per-request timeout
async function searchWithTimeout(query, timeoutMs = 5_000) {
  return solrRequest('/select', {
    params: query,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Combine a per-request timeout with an external cancellation signal
function combineSignals(...signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

// Usage: abort if either the 5s timeout fires or the caller cancels
async function searchCancellable(query, externalSignal) {
  const combined = combineSignals(AbortSignal.timeout(5_000), externalSignal);
  return solrRequest('/select', { params: query, signal: combined });
}
```

---

### 4.3 Circuit Breaker with `opossum`

For high-traffic services, a circuit breaker prevents cascade failures when Solr is overloaded. The `opossum` library (by NodeShift, actively maintained) is the standard choice.

```js
import CircuitBreaker from 'opossum';
import { search } from './search.mjs';

const breaker = new CircuitBreaker(search, {
  timeout: 5_000,           // calls taking longer than 5s are failures
  errorThresholdPercentage: 50, // open circuit if 50%+ of calls fail
  resetTimeout: 30_000,     // try again after 30s
  volumeThreshold: 10,      // minimum calls before evaluating error rate
});

breaker.on('open', () => console.error('Solr circuit breaker OPEN — returning fallbacks'));
breaker.on('halfOpen', () => console.info('Solr circuit breaker HALF-OPEN — testing...'));
breaker.on('close', () => console.info('Solr circuit breaker CLOSED — service restored'));

// Fallback when circuit is open
breaker.fallback(() => ({ numFound: 0, docs: [] }));

export async function safeSearch(params) {
  return breaker.fire(params);
}
```

---

### 4.4 SolrCloud Failover

When using multiple Solr nodes directly (without an external load balancer), implement simple failover:

```js
// solr-cloud-client.mjs
const NODES = process.env.SOLR_NODES.split(',');
const UNHEALTHY = new Map(); // node → Date when it failed
const UNHEALTHY_TTL = 30_000; // retry unhealthy nodes after 30s

function healthyNodes() {
  const now = Date.now();
  return NODES.filter(node => {
    const failedAt = UNHEALTHY.get(node);
    if (!failedAt) return true;
    if (now - failedAt > UNHEALTHY_TTL) {
      UNHEALTHY.delete(node); // give it another chance
      return true;
    }
    return false;
  });
}

export async function robustRequest(core, path, options) {
  const nodes = healthyNodes();
  if (nodes.length === 0) throw new Error('All Solr nodes are unhealthy');

  for (const node of nodes) {
    try {
      const url = new URL(`${node}/solr/${core}${path}`);
      // ... build and fire request
      return result;
    } catch (err) {
      if (isNetworkError(err)) {
        UNHEALTHY.set(node, Date.now());
        console.warn(`Marked Solr node ${node} as unhealthy: ${err.message}`);
        continue; // try next node
      }
      throw err; // non-network errors (bad query etc.) — propagate immediately
    }
  }
  throw new Error('All Solr nodes failed for this request');
}

function isNetworkError(err) {
  return err.cause?.code === 'ECONNREFUSED' ||
         err.cause?.code === 'ECONNRESET' ||
         err.cause?.code === 'ETIMEDOUT' ||
         err.name === 'AbortError';
}
```

---

### 4.5 Connection Pooling

Node.js `fetch` (backed by `undici`) manages connection pooling automatically via HTTP keep-alive. You can tune the pool:

```js
// Node.js 20+: configure undici dispatcher globally
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({
  connections: 100,         // max connections per origin
  pipelining: 1,            // HTTP/1.1 pipelining (keep at 1 for Solr)
  keepAliveTimeout: 60_000, // keep connections open for 60s
  keepAliveMaxTimeout: 300_000,
}));
```

For `solr-client`, the underlying `http.request` uses Node's built-in keep-alive agent which you can configure via the `agent` option in the client constructor.

---

## 5. Indexing Pipeline Patterns

### 5.1 Bulk Indexing with Batching and Back-Pressure

Never send documents one at a time. Solr's indexing throughput scales dramatically with batch size — from 1 doc/request to 1,000 docs/request is often a 10–15x throughput increase. However, batches that are too large risk HTTP request timeouts or OOM on the Solr heap.

**Rule of thumb:** 500–2000 documents per batch, 4–8 concurrent requests.

```js
// batch-indexer.mjs
import { addDocuments } from './add-documents.mjs';
import { withRetry } from './retry.mjs';

/**
 * Index documents in batches with bounded concurrency (back-pressure).
 *
 * @param {AsyncIterable<object>|Iterable<object>} source - Document source
 * @param {object} opts
 * @param {number} [opts.batchSize]        - Documents per Solr request
 * @param {number} [opts.concurrency]      - Max parallel Solr requests
 * @param {boolean} [opts.softCommit]      - Use soft commits between batches
 */
export async function bulkIndex(source, { batchSize = 1000, concurrency = 4, softCommit = true } = {}) {
  const inFlight = new Set();
  let batch = [];
  let total = 0;
  let errors = 0;

  async function flush(docs) {
    const docsCopy = [...docs];
    const promise = withRetry(
      () => addDocuments(docsCopy, { softCommit }),
      { maxAttempts: 3, baseDelayMs: 500 },
    ).then(() => {
      total += docsCopy.length;
      if (total % 10_000 === 0) console.log(`Indexed ${total} documents (${errors} errors)`);
    }).catch(err => {
      errors += docsCopy.length;
      console.error(`Batch of ${docsCopy.length} failed: ${err.message}`);
    }).finally(() => {
      inFlight.delete(promise);
    });

    inFlight.add(promise);

    // Back-pressure: wait until concurrency slot is available
    while (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  }

  for await (const doc of source) {
    batch.push(doc);
    if (batch.length >= batchSize) {
      await flush(batch);
      batch = [];
    }
  }

  // Flush remaining
  if (batch.length > 0) await flush(batch);

  // Wait for all in-flight requests to complete
  await Promise.all(inFlight);

  console.log(`Bulk index complete: ${total} indexed, ${errors} failed`);
  return { total, errors };
}
```

---

### 5.2 Using `worker_threads` for Parallel Indexing

For CPU-bound transformations (e.g., heavy JSON reshaping, text normalization, embedding generation) before indexing, offload work to worker threads while the main thread handles I/O coordination.

```js
// indexer-main.mjs  — orchestrator
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { bulkIndex } from './batch-indexer.mjs';

if (isMainThread) {
  // Main thread: reads from source, distributes to workers, collects transformed docs
  async function parallelIndex(sourceRecords) {
    const NUM_WORKERS = 4;
    const workers = Array.from({ length: NUM_WORKERS }, (_, i) =>
      new Worker(new URL(import.meta.url), { workerData: { workerId: i } })
    );

    // Round-robin distribution to workers
    let workerIndex = 0;
    const pendingByWorker = workers.map(() => []);
    const results = [];

    async function* transformedDocs() {
      // Simple approach: transform in main thread, shard to workers for heavier work
      for (const record of sourceRecords) {
        yield transformRecord(record); // or post to a worker
      }
    }

    await bulkIndex(transformedDocs(), { batchSize: 500, concurrency: 4 });

    for (const worker of workers) await worker.terminate();
  }
}

// Worker thread: CPU-intensive transformation
if (!isMainThread) {
  parentPort.on('message', (records) => {
    const transformed = records.map(transformRecord);
    parentPort.postMessage(transformed);
  });
}

function transformRecord(raw) {
  // Expensive normalization, field mapping, content extraction, etc.
  return {
    id: String(raw.id),
    title: raw.title?.trim(),
    body: raw.content?.replace(/<[^>]+>/g, ''), // strip HTML
    created_at: new Date(raw.createdAt).toISOString(),
    status: raw.published ? 'published' : 'draft',
  };
}
```

**When worker_threads actually help:**
- Parsing large CSV/XML/HTML bodies before indexing
- Running ML models (embeddings) per document
- Heavy regex normalization on large text fields

**When they do NOT help:**
- Simple field mapping — the JSON serialization overhead of cross-thread messaging exceeds the work saved
- I/O-bound workloads — use `concurrency` in the batch indexer instead

---

### 5.3 Incremental vs. Full Re-Index Strategies

**Incremental indexing (preferred for ongoing ingestion):**
- Track a `lastIndexedAt` watermark in your database or a state file
- Query your source for records modified since the watermark
- Use Solr atomic updates for field-level changes to avoid full re-index
- Keep watermark behind current time by a buffer (e.g., 5 minutes) to handle clock skew

```js
// incremental-index.mjs
import { bulkIndex } from './batch-indexer.mjs';
import { readWatermark, writeWatermark } from './watermark.mjs';

export async function incrementalIndex(db) {
  const since = await readWatermark();
  const now = new Date();

  const changedRecords = db.query(
    'SELECT * FROM articles WHERE updated_at > ? ORDER BY updated_at ASC',
    [since],
  );

  let count = 0;
  async function* source() {
    for await (const row of changedRecords) {
      yield transformRecord(row);
      count++;
    }
  }

  await bulkIndex(source(), { batchSize: 500, softCommit: true });

  // Write new watermark only after successful index
  await writeWatermark(new Date(now.getTime() - 5 * 60 * 1000)); // 5 min buffer
  console.log(`Incremental index: ${count} documents updated`);
}
```

**Full re-index strategy:**
For schema changes or corruption recovery, a safe full re-index avoids downtime by indexing into an alternate collection and swapping aliases.

```js
// full-reindex.mjs — alias swap pattern
async function fullReindex(db) {
  const newCore = `mycore_${Date.now()}`;

  // 1. Create new collection (SolrCloud) or core (standalone)
  await solrAdminRequest('/cores', { action: 'CREATE', name: newCore, configSet: 'myconfig' });

  // 2. Index everything into new core
  const source = db.query('SELECT * FROM articles ORDER BY id ASC');
  await bulkIndexToCore(source, newCore, { batchSize: 1000, concurrency: 6 });

  // 3. Hard commit the new core
  await solrRequest(`${newCore}/update`, { method: 'POST', body: { commit: {} } });

  // 4. Swap the alias (SolrCloud) — zero downtime cutover
  await solrAdminRequest('/collections', {
    action: 'CREATEALIAS',
    name: 'mycore',
    collections: newCore,
  });

  // 5. Delete old core/collection
  // ... cleanup

  console.log(`Full re-index complete. Active core: ${newCore}`);
}
```

---

## Appendix: Quick Reference — Solr Endpoints

| Operation | Method | Endpoint | Body / Params |
|---|---|---|---|
| Search | GET | `/select` | `q`, `fq`, `fl`, `rows`, `start`, `sort` |
| JSON query | POST | `/query` | JSON body with `query`, `filter`, `facet` |
| Index / Update | POST | `/update` | JSON array of documents |
| Atomic update | POST | `/update` | JSON array with modifier objects |
| Delete by ID | POST | `/update` | `{ delete: { id: "..." } }` |
| Delete by query | POST | `/update` | `{ delete: { query: "..." } }` |
| Hard commit | POST | `/update` | `{ commit: {} }` or `?commit=true` |
| Soft commit | POST | `/update` | `{ softCommit: true }` |
| Optimize | POST | `/update` | `{ optimize: { maxSegments: 1 } }` |
| Ping | GET | `/admin/ping` | — |
| Suggest | GET | `/suggest` | `suggest.q`, `suggest.dictionary` |
| Spellcheck | GET | `/spell` | `q`, `spellcheck=true` |
| Schema info | GET | `/schema` | — |

---

## References

- [Apache Solr Reference Guide — Pagination of Results](https://solr.apache.org/guide/solr/latest/query-guide/pagination-of-results.html)
- [Apache Solr Reference Guide — Indexing with Update Handlers](https://solr.apache.org/guide/solr/latest/indexing-guide/indexing-with-update-handlers.html)
- [Apache Solr Reference Guide — Commits and Transaction Logs](https://solr.apache.org/guide/solr/latest/configuration-guide/commits-transaction-logs.html)
- [Apache Solr Reference Guide — JSON Facet API](https://solr.apache.org/guide/solr/latest/query-guide/json-facet-api.html)
- [Apache Solr Reference Guide — Highlighting](https://solr.apache.org/guide/solr/latest/query-guide/highlighting.html)
- [Apache Solr Reference Guide — SolrCloud Distributed Requests](https://solr.apache.org/guide/solr/latest/deployment-guide/solrcloud-distributed-requests.html)
- [solr-client npm package](https://www.npmjs.com/package/solr-client) — lbdremy/solr-node-client
- [solr-node GitHub](https://github.com/godong9/solr-node) — godong9/solr-node (abandoned)
- [opossum — Node.js Circuit Breaker](https://github.com/nodeshift/opossum)
- [Solr Batch Indexing — Lucidworks](https://lucidworks.com/post/solr-batch-indexing/)
- [Solr Improving Performance for Batch Indexing — Box Engineering](https://blog.box.com/solr-improving-performance-batch-indexing)
- [Understanding Transaction Logs, Soft Commit and Commit in SolrCloud — Lucidworks](https://lucidworks.com/post/understanding-transaction-logs-softcommit-and-commit-in-sorlcloud/)
- [Efficient Cursor-Based Iteration — Lucidworks](https://lucidworks.com/blog/coming-soon-to-solr-efficient-cursor-based-iteration-of-large-result-sets/)
