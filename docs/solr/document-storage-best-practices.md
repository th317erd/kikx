# Solr 9.x Document Storage Best Practices

A comprehensive guide to document storage strategies in Apache Solr 9.x, with a focus on large documents (hundreds of megabytes).

---

## Table of Contents

1. [General Document Storage](#1-general-document-storage)
   - [store=true vs store=false](#11-storetrue-vs-storefalse)
   - [DocValues vs Stored Fields](#12-docvalues-vs-stored-fields)
   - [Field Compression Options](#13-field-compression-options)
   - [Full Content vs External Reference](#14-full-content-vs-external-reference)
   - [Schema Design: Metadata vs Content Fields](#15-schema-design-metadata-vs-content-fields)
   - [Nested / Child Documents](#16-nested--child-documents-in-solr-9x)
   - [Atomic Updates vs Full Reindexing](#17-atomic-updates-vs-full-document-reindexing)

2. [Large Document Considerations](#2-large-document-considerations)
   - [Solr Size Limits](#21-solrs-limits-on-document-size)
   - [Chunking Strategies](#22-chunking-strategies)
   - [Streaming Large Documents via Tika](#23-streaming-large-documents-solr-cell--tika)
   - [External File Fields](#24-external-file-fields)
   - [Performance Impact of Large Stored Fields](#25-performance-impact-of-large-stored-fields)
   - [JVM Heap Tuning](#26-jvm-heap-tuning-for-large-document-workloads)
   - [Codec Compression of Stored Fields](#27-compression-of-large-stored-fields-codec-configuration)
   - [When NOT to Store Content in Solr](#28-when-not-to-store-large-content-in-solr)
   - [Real-World Architecture](#29-real-world-architecture-object-storage--solr)

---

## 1. General Document Storage

### 1.1 store=true vs store=false

Every Solr field has two independent axes of persistence: **indexing** (for search) and **storing** (for retrieval). Conflating the two is one of the most common Solr schema mistakes.

| Setting | Indexed | Stored | Effect |
|---|---|---|---|
| `indexed="true" stored="true"` | Yes | Yes | Searchable AND retrievable — default for most text fields |
| `indexed="true" stored="false"` | Yes | No | Searchable but not returned in results (good for copyField targets) |
| `indexed="false" stored="true"` | No | Yes | Not searchable, but returned in results (display-only fields) |
| `indexed="false" stored="false"` | No | No | Useful only with docValues for sorting/faceting |

**Key rule:** Only store fields you need back in search responses. Every stored byte consumes disk I/O during retrieval — Solr must scan all stored fields sequentially to return even a single one.

```xml
<!-- schema.xml examples -->

<!-- Full-text body: index it, but DO NOT store — store only an excerpt -->
<field name="body_text" type="text_en" indexed="true" stored="false" />

<!-- Excerpt for display -->
<field name="body_excerpt" type="text_en" indexed="false" stored="true" />

<!-- Title: searchable AND displayable -->
<field name="title" type="text_en" indexed="true" stored="true" />

<!-- Internal routing key: indexed for filtering, not needed in results -->
<field name="tenant_id" type="string" indexed="true" stored="false" docValues="true" />

<!-- copyField target: never stored -->
<field name="_text_" type="text_en" indexed="true" stored="false" multiValued="true" />
<copyField source="title" dest="_text_" />
<copyField source="body_text" dest="_text_" />
```

**When to use `stored="true"`:**
- Fields you need to display to the end user
- Fields needed for highlighting (Solr highlights from stored content)
- Fields needed for atomic update (Solr must re-fetch the full document internally)

**When to use `stored="false"`:**
- `copyField` destinations (always false — they are derived)
- High-cardinality filter fields that only need to exist in the index
- Very large text bodies where you'll store only an excerpt
- Intermediate computed fields

---

### 1.2 DocValues vs Stored Fields

DocValues are a column-oriented on-disk data structure for numeric and string fields. They are the right choice for sorting, faceting, grouping, and function queries. Stored fields are row-oriented and are the right choice when you need to return many fields per document.

#### How they differ internally

```
Stored Fields (Row Store)           DocValues (Column Store)
───────────────────────────         ─────────────────────────
Doc 0: [title|date|price|...]       date column: [2024|2023|2024|...]
Doc 1: [title|date|price|...]       price column: [9.99|14.99|4.99|...]
Doc 2: [title|date|price|...]
       ↑ Sequential scan to         ↑ Direct random access to
         reach any field              any doc's value
```

#### Decision matrix

| Operation | Best Approach | Reason |
|---|---|---|
| Sorting (`sort=price asc`) | DocValues | Direct random access, no sequential scan |
| Faceting (`facet.field=category`) | DocValues | Column scan is fast; avoids fieldCache heap pressure |
| Grouping | DocValues | Same as faceting |
| Returning 1-5 fields in results | DocValues | Avoids stored field row scan entirely |
| Returning 20+ fields in results | Stored fields | Row fetch more efficient than 20 column lookups |
| Highlighting | Stored fields only | Requires original text with offsets |
| Text fields (analyzed) | Stored fields only | DocValues cannot store analyzed text |
| Numeric updates (in-place) | DocValues only | In-place updates require non-stored docValues numerics |

#### Using both simultaneously

Many fields benefit from both:

```xml
<!-- Price: docValues for sorting/faceting, stored for display -->
<field name="price" type="pfloat"
       indexed="false"
       stored="true"
       docValues="true" />

<!-- Status: docValues for faceting, no need to store separately -->
<field name="status" type="string"
       indexed="true"
       stored="false"
       docValues="true"
       useDocValuesAsStored="true" />
```

`useDocValuesAsStored="true"` causes Solr to return the docValues data as if it were stored — giving you the best of both worlds without duplicating storage, but only for single-valued string/numeric fields where the original value is not transformed.

#### Performance benchmark summary

From Sease benchmarks (1M Wikipedia documents, 100 fields each):

- Returning fewer than 20 fields: DocValues is faster (better memory locality, skips stored field scan)
- Returning 20+ fields: Stored fields are faster (one sequential row read vs. 20+ column lookups)
- Heap usage: DocValues lives off-heap (memory-mapped), stored fields may require heap allocation during retrieval

---

### 1.3 Field Compression Options

Solr 9.x uses Lucene's `SchemaCodecFactory` by default, which applies LZ4 compression to stored fields automatically. You can configure this behavior in `solrconfig.xml`.

#### Available compression modes

| Mode | Algorithm | Block Size | Trade-off |
|---|---|---|---|
| `BEST_SPEED` (default) | LZ4 | 16 KB | Fast compression/decompression; moderate ratio |
| `BEST_COMPRESSION` | DEFLATE | 48 KB + shared dict | Better ratio; slower I/O bound workloads |

#### solrconfig.xml configuration

```xml
<!-- Default: BEST_SPEED — prioritizes query throughput -->
<codecFactory class="solr.SchemaCodecFactory">
  <str name="compressionMode">BEST_SPEED</str>
</codecFactory>

<!-- Alternative: BEST_COMPRESSION — prioritizes disk space -->
<codecFactory class="solr.SchemaCodecFactory">
  <str name="compressionMode">BEST_COMPRESSION</str>
</codecFactory>

<!-- Development only — NEVER use in production -->
<!-- <codecFactory class="solr.SimpleTextCodecFactory" /> -->
```

#### When to use BEST_COMPRESSION

- Collections with very large stored text fields (documents over 1 MB stored per doc)
- I/O-constrained environments (spinning disk, NFS, S3-backed storage)
- Archival collections where query frequency is low
- When disk cost is a significant concern

#### When to stick with BEST_SPEED (the default)

- Query-heavy workloads where sub-100ms latency matters
- Collections that fit in OS page cache
- Many small stored fields frequently retrieved together
- SSD-backed storage where raw throughput is high

**Note:** Compression happens at the Lucene segment level, not per-field. You cannot selectively compress individual fields differently within the same collection.

---

### 1.4 Full Content vs External Reference

One of the most consequential architectural decisions is whether to store document content inside Solr or keep it externally and store only a reference.

#### Option A: Full content in Solr

```xml
<field name="content" type="text_en" indexed="true" stored="true" />
```

**Pros:**
- Simple single-system retrieval
- Highlighting works natively
- No external dependency at query time

**Cons:**
- Massive stored field overhead for large documents
- Segment merges become expensive
- Heap pressure during retrieval
- Solr not designed as a document store

#### Option B: Reference + excerpt in Solr, content in external storage

```xml
<!-- Only store enough for display and highlighting -->
<field name="content_url" type="string" indexed="false" stored="true" />
<field name="content_excerpt" type="text_en" indexed="true" stored="true" />
<field name="content_full_text" type="text_en" indexed="true" stored="false" />
```

**Pros:**
- Dramatically smaller stored field footprint
- Solr stays fast; object storage handles bulk bytes
- Scale content storage independently
- Simpler backup/restore (Solr index is compact)

**Cons:**
- Two-system retrieval for full content
- Highlighting requires fetching from external store or pre-computing excerpts

**Recommendation:** For documents over 100 KB, use Option B. Store a `content_url` (S3/filesystem path) and a `content_excerpt` (first 500-1000 characters or a meaningful snippet). Index the full text without storing it. Fetch full content from external storage on demand.

---

### 1.5 Schema Design: Metadata vs Content Fields

Separate your schema conceptually into three tiers:

```
┌─────────────────────────────────────────────────────────┐
│  TIER 1: METADATA (small, fast)                         │
│  stored=true, docValues=true, indexed=true              │
│  title, author, date, category, status, tenant_id       │
│  purpose: filtering, sorting, faceting, display         │
├─────────────────────────────────────────────────────────┤
│  TIER 2: EXCERPT / DISPLAY (medium, stored)             │
│  stored=true, indexed=true (or false)                   │
│  content_excerpt, summary, highlight_text               │
│  purpose: display in search results, highlighting       │
├─────────────────────────────────────────────────────────┤
│  TIER 3: FULL TEXT (large, index-only)                  │
│  stored=false, indexed=true                             │
│  body_text, appendix_text, ocr_text                     │
│  purpose: full-text search scoring, NO retrieval        │
└─────────────────────────────────────────────────────────┘
```

#### Example schema for a document management system

```xml
<!-- schema.xml -->

<!-- TIER 1: Metadata -->
<field name="id"          type="string"    indexed="true"  stored="true"  required="true" />
<field name="title"       type="text_en"   indexed="true"  stored="true"  />
<field name="author"      type="string"    indexed="true"  stored="true"  docValues="true" />
<field name="created_dt"  type="pdate"     indexed="true"  stored="true"  docValues="true" />
<field name="modified_dt" type="pdate"     indexed="true"  stored="true"  docValues="true" />
<field name="category"    type="string"    indexed="true"  stored="true"  docValues="true" multiValued="true" />
<field name="mime_type"   type="string"    indexed="true"  stored="true"  docValues="true" />
<field name="file_size_b" type="plong"     indexed="false" stored="true"  docValues="true" />
<field name="language"    type="string"    indexed="true"  stored="true"  docValues="true" />
<field name="tenant_id"   type="string"    indexed="true"  stored="false" docValues="true" />

<!-- TIER 2: Excerpt (stored for display, indexed for highlighting) -->
<field name="content_url"     type="string"  indexed="false" stored="true" />
<field name="content_excerpt" type="text_en" indexed="true"  stored="true" />

<!-- TIER 3: Full text (indexed for search, not stored) -->
<field name="body_text"   type="text_en" indexed="true" stored="false" multiValued="true" />
<field name="header_text" type="text_en" indexed="true" stored="false" multiValued="true" />

<!-- Catch-all search field -->
<field name="_text_" type="text_en" indexed="true" stored="false" multiValued="true" />
<copyField source="title"       dest="_text_" />
<copyField source="body_text"   dest="_text_" />
<copyField source="header_text" dest="_text_" />
```

---

### 1.6 Nested / Child Documents in Solr 9.x

Solr 9.x has first-class support for nested documents (also called block documents). This is the foundation of the chunking strategy described in section 2.2.

#### Required schema fields

```xml
<!-- schema.xml — REQUIRED for nested docs -->
<field name="_root_"     type="string"       indexed="true" stored="false" docValues="false" />
<fieldType name="_nest_path_" class="solr.NestPathField" />
<field name="_nest_path_" type="_nest_path_" />

<!-- Optional but strongly recommended -->
<field name="_nest_parent_" type="string" indexed="true" stored="true" />

<!-- Document type discriminator -->
<field name="doc_type" type="string" indexed="true" stored="true" docValues="true" />
```

#### Indexing nested documents (JSON)

```json
[
  {
    "id": "doc_001",
    "doc_type": "parent",
    "title": "Annual Report 2024",
    "author": "Finance Team",
    "created_dt": "2024-01-15T00:00:00Z",
    "content_url": "s3://my-bucket/docs/annual-report-2024.pdf",
    "chunks": [
      {
        "id": "doc_001_chunk_0",
        "doc_type": "chunk",
        "chunk_seq": 0,
        "chunk_text": "Executive Summary. This report covers fiscal year 2024..."
      },
      {
        "id": "doc_001_chunk_1",
        "doc_type": "chunk",
        "chunk_seq": 1,
        "chunk_text": "Revenue increased 12% year-over-year driven by..."
      }
    ]
  }
]
```

#### Querying: find parents where children match

```
# Return parent documents where any chunk contains "revenue increase"
q={!parent which="doc_type:parent"}(doc_type:chunk AND chunk_text:"revenue increase")

# Include matching child documents in results
fl=id,title,author,[child]
```

#### Key constraints

- All children of a parent must be indexed together in a single add operation.
- You cannot update a single child without reindexing the entire parent+children block.
- Delete-by-ID only works on root documents. Delete children with `delete?q=_root_:doc_001`.
- Every document (parent and child) needs a globally unique `id`.

---

### 1.7 Atomic Updates vs Full Document Reindexing

#### How atomic updates work internally

Despite the name, Solr does **not** do a true partial update at the storage layer. Under the hood:

```
Atomic update request (set price=14.99)
    │
    ▼
Solr fetches current stored doc from index
    │
    ▼
Merges changed field into fetched document
    │
    ▼
Indexes the merged full document as new version
    │
    ▼
Old version marked for deletion (soft delete)
```

This means atomic updates require **all fields** to be either `stored="true"` or `docValues="true"`. Fields that are neither cannot be preserved through an atomic update cycle.

#### In-place updates (Solr 9 optimization)

In-place updates bypass the fetch-merge-reindex cycle for a specific subset of field types:

**Requirements for in-place updates:**
- Single-valued numeric fields only
- `docValues="true"`
- `indexed="false"`
- `stored="false"`
- `_version_` field must also be non-indexed, non-stored docValues

```xml
<!-- Fields eligible for in-place updates -->
<field name="view_count"  type="plong"   indexed="false" stored="false" docValues="true" />
<field name="score"       type="pfloat"  indexed="false" stored="false" docValues="true" />
<field name="rank"        type="pint"    indexed="false" stored="false" docValues="true" />
<field name="_version_"   type="plong"   indexed="false" stored="false" docValues="true" />
```

```json
// In-place update: increment view_count
{
  "id": "doc_001",
  "view_count": {"inc": 1}
}
```

#### Decision guide

| Scenario | Recommendation |
|---|---|
| Updating only numeric counters/scores | In-place update (fastest) |
| Updating a few metadata fields (status, category) | Atomic update |
| Re-extracting full text from source | Full reindex |
| Updating a large document with many chunks | Full reindex (atomic updates cannot address children individually) |
| Updating after document content changes | Full reindex + rechunk |

---

## 2. Large Document Considerations

### 2.1 Solr's Limits on Document Size

Before indexing large documents, understand where Solr's hard limits lie.

#### HTTP POST size limits (solrconfig.xml)

```xml
<!-- solrconfig.xml -->
<requestDispatcher>
  <requestParsers
    enableRemoteStreaming="true"
    multipartUploadLimitInKB="102400"
    formdataUploadLimitInKB="102400"
    addHttpRequestToContext="false" />
</requestDispatcher>
```

| Parameter | Default | Notes |
|---|---|---|
| `multipartUploadLimitInKB` | 2048 KB (2 MB) | Hard cap on multipart POST body size |
| `formdataUploadLimitInKB` | 2048 KB (2 MB) | Hard cap on URL-encoded form data |

For large document pipelines, set both to a generous value (e.g., 512 MB = 524288 KB) or use `-1` for unlimited (not recommended for public-facing instances).

**Upstream limits also apply.** If Solr sits behind Nginx or a load balancer, those also impose body size limits:

```nginx
# nginx.conf
client_max_body_size 512m;
```

#### maxBooleanClauses (solr.xml)

```xml
<!-- solr.xml -->
<solr>
  <int name="maxBooleanClauses">${solr.max.booleanClauses:1024}</int>
</solr>
```

This limits the number of clauses in a single Boolean query. Relevant when large documents are chunked and you query for chunk IDs using `OR` clauses. With 1024 as default, you cannot filter more than 1024 chunk IDs in a single boolean query — design your chunk retrieval queries accordingly.

#### Jetty / JVM memory limits

Solr's embedded Jetty server will reject requests that would cause OOM conditions. With very large bodies, you may need to increase the Jetty header buffer size:

```
# solr.in.sh
SOLR_JETTY_CONFIG+=" --module=http"
SOLR_OPTS+=" -Dsolr.jetty.request.header.size=65536"
```

#### Tika extraction limit

When using Solr Cell (Tika integration):

| Setting | Default | Description |
|---|---|---|
| `tikaserver.maxChars` | 100,000,000 (100 MB) | Hard limit on extracted character response |
| `tikaserver.timeoutSeconds` | 180 | Per-request timeout to Tika server |

---

### 2.2 Chunking Strategies

For documents too large to fit cleanly into a single Solr document (or where fine-grained retrieval is needed), chunking is the standard approach.

#### The core chunking pattern

```
                     LARGE DOCUMENT
                          │
          ┌───────────────┼───────────────┐
          │               │               │
       Chunk 0         Chunk 1         Chunk 2
    (0-1000 chars) (1000-2000 chars) (2000-3000 chars)
          │               │               │
          └───────────────┼───────────────┘
                          │
                   Parent Document
                  (metadata only)
```

#### Strategy 1: Fixed-size chunking (simplest)

Split text every N characters or N tokens. Fast to implement, predictable index size.

```python
def chunk_fixed(text, chunk_size=1000, overlap=100):
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        start = end - overlap  # overlap for context continuity
    return chunks
```

**Use when:** Documents are homogeneous text without natural boundaries (logs, transcripts).

#### Strategy 2: Semantic/paragraph-boundary chunking (recommended)

Split at natural language boundaries: paragraphs, headings, sections.

```python
def chunk_semantic(text, max_chars=1500):
    paragraphs = text.split('\n\n')
    chunks = []
    current = []
    current_len = 0

    for para in paragraphs:
        if current_len + len(para) > max_chars and current:
            chunks.append('\n\n'.join(current))
            current = [para]
            current_len = len(para)
        else:
            current.append(para)
            current_len += len(para)

    if current:
        chunks.append('\n\n'.join(current))

    return chunks
```

**Use when:** Documents have clear paragraph or section structure (reports, articles, manuals).

#### Strategy 3: Structural chunking (for rich documents)

Use document structure metadata from Tika (headers, sections, pages) as chunk boundaries. Each heading-delimited section becomes one chunk.

**Use when:** PDFs or Word docs with table of contents, chapters, or explicit sections.

#### Solr indexing with parent-child nesting

```json
POST /solr/documents/update?commit=true

[
  {
    "id": "DOC-20240115-001",
    "doc_type": "parent",
    "title": "Q4 Financial Report",
    "author": "Finance",
    "created_dt": "2024-01-15T00:00:00Z",
    "category": ["finance", "reports"],
    "mime_type": "application/pdf",
    "file_size_b": 52428800,
    "content_url": "s3://corp-docs/reports/q4-2024.pdf",
    "content_excerpt": "This report covers Q4 2024 financial results...",
    "chunks": [
      {
        "id": "DOC-20240115-001_c0",
        "doc_type": "chunk",
        "chunk_seq": 0,
        "chunk_text": "Executive Summary. Revenue for Q4 2024 reached $2.1B..."
      },
      {
        "id": "DOC-20240115-001_c1",
        "doc_type": "chunk",
        "chunk_seq": 1,
        "chunk_text": "Operating Expenses. Total operating expenses were..."
      }
    ]
  }
]
```

#### Querying chunks, returning parents

```
# Search chunks, return parent metadata
q={!parent which="doc_type:parent"}(doc_type:chunk AND chunk_text:"operating expenses")
fl=id,title,author,created_dt,content_url,content_excerpt
sort=score desc
rows=10
```

#### Chunk sizing guidelines

| Document type | Recommended chunk size | Overlap |
|---|---|---|
| Legal/regulatory docs | 500-800 chars | 100 chars |
| Technical documentation | 800-1200 chars | 150 chars |
| News articles / blog posts | 1000-2000 chars | 0-100 chars |
| Academic papers | 1000-1500 chars | 150 chars |
| Books / long-form text | 1500-2000 chars | 200 chars |

**Avoid:** Chunks smaller than 200 characters (too little context) or larger than 4000 characters (diminishing retrieval precision).

---

### 2.3 Streaming Large Documents: Solr Cell / Tika

Solr Cell uses Apache Tika to extract text from binary formats (PDF, DOCX, PPTX, XLSX, etc.) before indexing.

#### Architecture: Tika as external process (Solr 9.x requirement)

Solr 9.x requires Tika to run as a **separate process** (Tika Server). Running Tika in-process with Solr is no longer supported and was never recommended for production. A Tika crash cannot take down the Solr JVM in this configuration.

```
┌─────────────────┐   HTTP POST binary file   ┌─────────────────┐
│  Indexing       │ ─────────────────────────► │  Tika Server    │
│  Pipeline       │                            │  :9998          │
│  (your code)    │ ◄───────────────────────── │  (Docker/jar)   │
└─────────────────┘   extracted text + meta    └─────────────────┘
        │
        │  POST extracted JSON
        ▼
┌─────────────────┐
│  Solr           │
│  :8983          │
│  /update        │
└─────────────────┘
```

#### solrconfig.xml: Tika handler configuration

```xml
<requestHandler name="/update/extract" class="solr.extraction.ExtractingRequestHandler">
  <lst name="defaults">
    <!-- Point to your external Tika Server -->
    <str name="tikaserver.url">http://tika-server:9998</str>

    <!-- Field mapping: Tika's "content" → Solr's "body_text" -->
    <str name="fmap.content">body_text</str>

    <!-- Lowercase all extracted metadata field names -->
    <bool name="lowernames">true</bool>

    <!-- Prefix unmapped fields (catches author, creator, etc.) -->
    <str name="uprefix">tika_</str>

    <!-- Hard limit on extracted characters (default 100M) -->
    <str name="tikaserver.maxChars">10000000</str>

    <!-- Timeout for Tika response (large PDFs can be slow) -->
    <int name="tikaserver.timeoutSeconds">300</int>
  </lst>
</requestHandler>
```

Enable the extraction module in `solr.in.sh`:

```bash
SOLR_MODULES=extraction
```

#### Uploading a binary file via curl

```bash
# Stream a PDF to Solr via Tika
curl -X POST \
  "http://solr:8983/solr/documents/update/extract?commit=true&literal.id=DOC-001&literal.title=My+Report" \
  -F "myfile=@/path/to/report.pdf;type=application/pdf"
```

#### Recommended production pattern: pre-extract with Tika, then POST JSON

Do NOT use Solr Cell as your indexing pipeline in production. Use it to prototype. For production:

```python
# 1. Extract text from Tika separately
import requests

with open('/path/to/document.pdf', 'rb') as f:
    response = requests.put(
        'http://tika-server:9998/tika',
        data=f,
        headers={'Accept': 'text/plain', 'Content-Type': 'application/pdf'}
    )
    extracted_text = response.text

# 2. Chunk the text
chunks = chunk_semantic(extracted_text)

# 3. Build Solr document with nested chunks
solr_doc = {
    "id": "DOC-001",
    "doc_type": "parent",
    "title": "My Report",
    "content_url": "s3://bucket/doc.pdf",
    "content_excerpt": extracted_text[:500],
    "chunks": [
        {"id": f"DOC-001_c{i}", "doc_type": "chunk", "chunk_seq": i, "chunk_text": chunk}
        for i, chunk in enumerate(chunks)
    ]
}

# 4. POST to Solr
requests.post('http://solr:8983/solr/documents/update?commit=true',
              json=[solr_doc])
```

**Advantages of pre-extraction:**
- Tika crash does not stall your Solr
- You control chunking before indexing
- You can retry extraction independently of indexing
- You can store/cache extracted text separately

---

### 2.4 External File Fields

Solr's `ExternalFileField` type allows you to keep field data entirely outside the Lucene index — stored in plain files on the filesystem, loaded at query time.

**Limitation:** ExternalFileField only supports numeric float values. It is designed for things like externally computed relevance scores, not for large binary content.

```xml
<!-- schema.xml: ExternalFileField for externally computed scores -->
<fieldType name="ExternalFileField" keyField="id"
           defVal="0" class="solr.ExternalFileField" valType="pfloat" />
<field name="editorial_score" type="ExternalFileField" />
```

```
# File format: external_editorial_score (in core's data directory)
doc_001=0.95
doc_002=0.72
doc_003=0.88
```

**This is NOT a solution for storing large binary content.** For large content, use object storage (see section 2.9).

For large binary content, the correct approach is:
1. Store the binary in S3/GCS/filesystem
2. Store the URL/path in a Solr `string` field (`stored="true"`)
3. At retrieval time, fetch from the external store using the URL

---

### 2.5 Performance Impact of Large Stored Fields

This is the single most important section for large document workloads. Stored fields interact badly with query performance in non-obvious ways.

#### The sequential scan problem

Solr stores documents in a row-oriented format. To retrieve field N, it must scan and skip fields 0 through N-1. When one of those fields is 500 KB of text:

```
Document stored fields (row format):
[id:12b][title:64b][author:32b][BODY_TEXT:500KB][excerpt:200b][date:8b]
                                ^^^^^^^^^^^^^^^^^
                                Skipping this costs CPU cache misses
                                even if you only asked for "id" and "title"
```

**Solr 6.5+ optimization (SOLR-10273):** Solr moves the **single largest field** to the **end** of the stored field array at index time. This means skipping it costs nothing — you stop before reaching it.

```
After optimization:
[id:12b][title:64b][author:32b][excerpt:200b][date:8b][BODY_TEXT:500KB]
                                                        ^^^^^^^^^^^^^^^^^
                                                        At end — never skipped
```

**Critical limitation:** This optimization only handles one large field. If you have **multiple** large stored fields, all but the last one will still cause performance degradation.

#### Measured impact (Sease benchmark)

A case study documented by Sease engineers showed:

| Configuration | P99 query latency |
|---|---|
| No large stored fields | ~10ms |
| One 500KB stored field (pre-6.5) | ~500ms |
| One 500KB stored field (6.5+ optimization) | ~12ms |
| Two 500KB stored fields | ~480ms |

**The takeaway:** Never store more than one large text field per document. If you need multiple large fields (e.g., body + appendix), concatenate them into one stored field or don't store them at all.

#### Heap and OS cache impact

Large stored fields affect memory in two places:

1. **JVM heap:** Solr's document cache holds recently retrieved documents in heap. One cached document with 500 KB of stored text costs 500 KB of heap. With a cache size of 512 documents, that is 256 MB of heap just for one field across the cache.

2. **OS page cache:** The stored field files (`*.fdt`, `*.fdx`) must be in OS page cache for fast I/O. Large stored fields bloat these files, pushing other useful data (postings lists, docValues) out of cache. This degrades both query and indexing performance.

**Rule of thumb:** For every 100 MB of stored text fields per million documents, expect to provision an additional 2-4 GB of system RAM for adequate OS page cache coverage.

---

### 2.6 JVM Heap Tuning for Large Document Workloads

#### General principles

Solr uses `MMapDirectory` by default, which memory-maps index files through the OS — **outside** the JVM heap. Therefore, allocating an excessively large JVM heap is counterproductive: it steals RAM from the OS page cache that Solr depends on.

```
Total Server RAM = JVM Heap + OS Page Cache + OS Overhead
                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                            Solr needs this for mmap I/O
```

**The right balance:**
- Heap: 8-24 GB (for most workloads)
- Leave at least 50% of RAM for OS page cache
- On a 64 GB server: heap no larger than 24-32 GB

#### JVM configuration for large document workloads

```bash
# solr.in.sh (or SOLR_JAVA_MEM environment variable)

# Equal Xms and Xmx to prevent heap resizing pauses
SOLR_JAVA_MEM="-Xms16g -Xmx16g"

# G1GC: best choice for Solr 9 on Java 17+
GC_TUNE="-XX:+UseG1GC \
  -XX:MaxGCPauseMillis=500 \
  -XX:+UnlockExperimentalVMOptions \
  -XX:G1MaxNewSizePercent=30 \
  -XX:G1NewSizePercent=5 \
  -XX:G1HeapRegionSize=32m \
  -XX:InitiatingHeapOccupancyPercent=70 \
  -XX:+ParallelRefProcEnabled"

# GC logging for diagnosis
GC_LOG_OPTS="-Xlog:gc*:file=${LOG_DIR}/gc.log:time,uptime:filecount=9,filesize=20m"
```

#### Memory estimation for large document collections

| Component | Memory formula | Example (1M docs, 100KB avg stored) |
|---|---|---|
| Stored fields in OS cache | Stored bytes × 1.2 | 100 KB × 1M × 1.2 = 120 GB |
| Inverted index (postings) | ~20-50 bytes per unique term | Varies |
| DocValues | ~8-16 bytes per doc per numeric field | Moderate |
| JVM heap baseline | 2-4 GB minimum | 4 GB |
| Heap for document cache | cache_size × avg_doc_size | 512 × 100KB = 50 MB |

For large document collections, **OS page cache is almost always the binding constraint**, not heap. Provision RAM accordingly.

#### Heap sizing rules of thumb

| Collection size | Avg stored per doc | Recommended heap |
|---|---|---|
| < 10M docs | < 1 KB | 8 GB |
| < 10M docs | 10-100 KB | 16 GB |
| < 10M docs | > 100 KB | 24 GB |
| > 10M docs | > 100 KB | Consider sharding + 16-24 GB per shard |

---

### 2.7 Compression of Large Stored Fields: Codec Configuration

As covered in section 1.3, Solr's codec controls stored field compression. For large document workloads, codec tuning deserves additional attention.

#### BEST_COMPRESSION for large text workloads

When stored fields are large and queries are not extremely latency-sensitive:

```xml
<!-- solrconfig.xml -->
<codecFactory class="solr.SchemaCodecFactory">
  <str name="compressionMode">BEST_COMPRESSION</str>
</codecFactory>
```

DEFLATE compression on natural language text typically achieves 3:1 to 8:1 compression ratios. A collection with 100 MB of stored text per 1000 documents might compress to 15-30 MB, dramatically improving OS page cache effectiveness.

#### Compression vs. caching trade-off

```
Without compression:                With BEST_COMPRESSION:
────────────────────                ─────────────────────
500 MB stored field files           70 MB stored field files
OS can cache 500 MB → lots of RAM   OS can cache 500 MB → fits entirely
Decompression: trivial (LZ4)        Decompression: moderate (DEFLATE)
Query: fast if in cache             Query: slightly slower decompress,
       slow if not (I/O bound)             but always in cache
```

**For large document workloads where the index does not fit in RAM, `BEST_COMPRESSION` is almost always the right choice.**

#### Per-field DocValues format (advanced)

For specific numeric docValues fields, you can specify a per-field codec in the field type:

```xml
<fieldType name="plong" class="solr.LongPointField" docValuesFormat="Direct" />
```

Available DocValues formats (Lucene codecs):
- `Direct`: Fast random access, higher memory usage (good for small cardinality)
- `Lucene90DocValuesFormat` (default): Balanced compression and speed

This is advanced tuning — the defaults are appropriate for most use cases.

---

### 2.8 When NOT to Store Large Content in Solr

Solr is a search engine, not a document store. There are clear signals that you have pushed too far:

#### Signals you should NOT be storing content in Solr

- Individual stored field values exceed 1 MB
- Segment merges take longer than indexing new documents
- OS page cache hit rate drops below 80% on store field files
- JVM GC pauses increase after indexing large batches
- Stored field files (`.fdt`) dominate disk usage (>60% of total index size)
- Backup/restore of the Solr collection takes hours
- You are storing binary content (images, video, raw PDFs) in stored fields

#### Use Solr for what it does well

```
✓ Solr: full-text search, faceting, sorting, filtering, relevance ranking
✗ Solr: binary blob storage, primary document store, raw file serving
```

#### Decision tree: should this content go into Solr?

```
Is the content > 100 KB per document?
│
├── YES → Store in object storage (S3, GCS, Azure Blob)
│          Store URL + excerpt in Solr
│
└── NO
    │
    Is the content binary (PDF, image, video, audio)?
    │
    ├── YES → Extract text with Tika, index text in Solr
    │          Store binary in object storage
    │          Store URL in Solr
    │
    └── NO
        │
        Is the content needed in search result displays?
        │
        ├── YES → stored="true" (but consider excerpt only)
        │
        └── NO → stored="false" (index only)
```

---

### 2.9 Real-World Architecture: Content in Object Storage, Solr Indexes Metadata + Excerpt

This is the recommended production architecture for large document collections.

#### Architecture diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         INGESTION PIPELINE                               │
│                                                                          │
│  Source Doc          Extraction         Transform           Index        │
│  (PDF, DOCX...)       Service           & Chunk                          │
│       │                  │                  │                  │         │
│       │  raw binary      │  extracted text  │  parent+chunks   │         │
│       ├─────────────────►│─────────────────►│─────────────────►│         │
│       │                  │                  │                  │         │
│       │  store binary    │   (Tika Server)  │                  │         │
│       ▼                  │                  │                  ▼         │
│  Object Storage          │                  │           Apache Solr      │
│  (S3/GCS/Azure)          │                  │           (metadata +      │
│       │                  │                  │            text index +    │
│       │                  │                  │            excerpt only)   │
│       │  presigned URL   │                  │                │           │
│       ◄──────────────────────────────────────────────────────┘           │
│       │                  │                  │                            │
└───────┼──────────────────┼──────────────────┼────────────────────────────┘
        │                  │                  │
        │                  │                  │
┌───────┼──────────────────┼──────────────────┼────────────────────────────┐
│       │           QUERY / RETRIEVAL          │                            │
│       │                                      │                            │
│  User query                                  │                            │
│       │                                      │                            │
│       ▼                                      │                            │
│  Search API                                  │                            │
│  (your app)                                  │                            │
│       │  search query                        │                            │
│       ├────────────────────────────────────► Solr                        │
│       │  results: id, title, excerpt, url    │                            │
│       ◄────────────────────────────────────── │                            │
│       │                                      │                            │
│       │  (optional) fetch full content       │                            │
│       ├──────────────────────────────────────► Object Storage             │
│       │  full binary / extracted text        │                            │
│       ◄──────────────────────────────────────                             │
│       │                                      │                            │
│       ▼                                      │                            │
│  Response to user                            │                            │
│                                              │                            │
└──────────────────────────────────────────────────────────────────────────┘
```

#### What lives where

| Data | Storage | Solr Field |
|---|---|---|
| Raw binary (PDF, DOCX) | S3/GCS | `content_url` (stored, string) |
| Extracted full text | S3/GCS or ephemeral | Indexed via `body_text` (not stored) |
| Text excerpt (500-1000 chars) | Solr stored field | `content_excerpt` (stored, text) |
| Metadata | Solr stored + docValues | All tier-1 fields |
| Chunk text (for retrieval) | Solr child doc | `chunk_text` (stored, text) |
| Chunk embeddings (optional) | Solr dense vector | `chunk_vector` (DenseVectorField) |

#### Solr schema for this architecture

```xml
<!-- schema.xml for content-in-object-storage architecture -->

<!-- Identity and routing -->
<field name="id"              type="string"  indexed="true"  stored="true"  required="true" />
<field name="doc_type"        type="string"  indexed="true"  stored="true"  docValues="true" />
<field name="_root_"          type="string"  indexed="true"  stored="false" docValues="false" />
<fieldType name="_nest_path_" class="solr.NestPathField" />
<field name="_nest_path_"     type="_nest_path_" />

<!-- Metadata (tier 1) -->
<field name="title"           type="text_en" indexed="true"  stored="true"  />
<field name="author"          type="string"  indexed="true"  stored="true"  docValues="true" multiValued="true" />
<field name="created_dt"      type="pdate"   indexed="true"  stored="true"  docValues="true" />
<field name="modified_dt"     type="pdate"   indexed="true"  stored="true"  docValues="true" />
<field name="category"        type="string"  indexed="true"  stored="true"  docValues="true" multiValued="true" />
<field name="tenant_id"       type="string"  indexed="true"  stored="false" docValues="true" />
<field name="language"        type="string"  indexed="true"  stored="true"  docValues="true" />
<field name="mime_type"       type="string"  indexed="true"  stored="true"  docValues="true" />
<field name="file_size_b"     type="plong"   indexed="false" stored="true"  docValues="true" />
<field name="page_count"      type="pint"    indexed="false" stored="true"  docValues="true" />

<!-- External content reference -->
<field name="content_url"     type="string"  indexed="false" stored="true"  />

<!-- Excerpt for display (tier 2) -->
<field name="content_excerpt" type="text_en" indexed="true"  stored="true"  />

<!-- Full text: index only, no store (tier 3) -->
<field name="body_text"       type="text_en" indexed="true"  stored="false" multiValued="true" />

<!-- Chunk fields (child documents only) -->
<field name="chunk_seq"       type="pint"    indexed="true"  stored="true"  docValues="true" />
<field name="chunk_text"      type="text_en" indexed="true"  stored="true"  />

<!-- Optional: dense vector for semantic search (Solr 9.x) -->
<fieldType name="knn_vector" class="solr.DenseVectorField"
           vectorDimension="1536" similarityFunction="cosine" />
<field name="chunk_vector"    type="knn_vector" indexed="true" stored="false" />

<!-- Catch-all -->
<field name="_text_"          type="text_en" indexed="true"  stored="false" multiValued="true" />
<copyField source="title"     dest="_text_" />
<copyField source="body_text" dest="_text_" />
```

#### Lifecycle operations

**Indexing a new document:**

```
1. Upload binary to S3, get URL
2. Send binary to Tika Server, get extracted text
3. Chunk extracted text (semantic chunking preferred)
4. POST parent + chunk nested document to Solr
5. Commit (or rely on autoCommit)
```

**Updating document metadata only:**

```
Atomic update on parent metadata fields (no rechunking needed)
POST: {"id": "DOC-001", "category": {"add": "archived"}}
```

**Updating document content:**

```
1. Upload new binary to S3 (new version URL)
2. Re-extract text with Tika
3. Re-chunk
4. DELETE existing parent + children: delete?q=_root_:DOC-001
5. POST new parent + chunks
6. Commit
```

**Deleting a document:**

```
DELETE by query: q=_root_:DOC-001
(This deletes parent + all children atomically)
```

---

## Summary: Quick Reference Decision Guide

```
FIELD TYPE DECISION:
┌─────────────────────┬────────────┬────────────┬────────────┐
│ Need                │ indexed    │ stored     │ docValues  │
├─────────────────────┼────────────┼────────────┼────────────┤
│ Full-text search    │ true       │ false      │ false      │
│ Exact filter        │ true       │ false      │ true       │
│ Sort / facet        │ false      │ false      │ true       │
│ Display in results  │ false      │ true       │ false      │
│ Atomic updates      │ (any)      │ true OR    │ true       │
│                     │            │ docValues  │            │
│ In-place numeric    │ false      │ false      │ true       │
│ update              │            │            │            │
│ Highlighting        │ true       │ true       │ false      │
└─────────────────────┴────────────┴────────────┴────────────┘

LARGE CONTENT DECISION:
  Content > 100 KB?     → Object storage + URL in Solr
  Content is binary?    → Extract with Tika, index text only
  Content is full text? → Index in Solr, store excerpt only
  Need semantic search? → Chunk + embed, store vector in Solr

COMPRESSION:
  Index fits in RAM?    → BEST_SPEED (default)
  Index exceeds RAM?    → BEST_COMPRESSION

JVM HEAP:
  Leave ≥50% RAM for OS page cache
  Set -Xms = -Xmx (avoid heap resizing)
  Use G1GC with MaxGCPauseMillis=500
  Scale via sharding before scaling heap >24 GB
```

---

## Sources

- [DocValues :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/indexing-guide/docvalues.html)
- [Partial Document Updates :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/indexing-guide/partial-document-updates.html)
- [Indexing Nested Documents :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/indexing-guide/indexing-nested-documents.html)
- [Codec Factory :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/configuration-guide/codec-factory.html)
- [JVM Settings :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/deployment-guide/jvm-settings.html)
- [Indexing with Solr Cell and Apache Tika :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/indexing-guide/indexing-with-tika.html)
- [Configuring solr.xml :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/configuration-guide/configuring-solr-xml.html)
- [RequestDispatcher :: Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/configuration-guide/requestdispatcher.html)
- [Impact of Large Stored Fields on Apache Solr Query Performance (Sease)](https://sease.io/2022/12/impact-of-large-stored-fields-on-apache-solr-query-performance.html)
- [DocValues vs Stored Fields: Apache Solr Performance SmackDown (Sease)](https://sease.io/2020/03/docvalues-vs-stored-fields-apache-solr-features-and-performance-smackdown.html)
- [Apache Solr Memory Tuning for Production (Cloudera)](https://www.cloudera.com/blog/technical/apache-solr-memory-tuning-for-production.html)
- [Optimizing Solr Resources with G1 (Blibli Tech Blog)](https://medium.com/bliblidotcom-techblog/optimizing-solr-resources-with-g1-448bb9c49d46)
- [Estimating Memory and Storage for Lucene/Solr (Lucidworks)](https://lucidworks.com/blog/estimating-memory-and-storage-for-lucenesolr)
- [Apache Solr Atomic Updates: a Polymorphic Approach (Sease)](https://sease.io/2020/01/apache-solr-atomic-updates-polymorphic-approach.html)
- [Lucene90StoredFieldsFormat API](https://lucene.apache.org/core/9_4_2/core/org/apache/lucene/codecs/lucene90/Lucene90StoredFieldsFormat.html)
