# Solr HTML Content Indexing: Complete Reference

**Solr version context:** 9.x (current stable as of 2025). Version-specific notes are called out explicitly where behavior differs from earlier releases.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Enabling the Extraction Module](#2-enabling-the-extraction-module)
3. [How Solr Ingests HTML: Tika and ExtractingRequestHandler](#3-how-solr-ingests-html-tika-and-extractingrequesthandler)
4. [Stripping HTML Tags vs. Indexing Raw HTML](#4-stripping-html-tags-vs-indexing-raw-html)
5. [Field Mapping from HTML Metadata](#5-field-mapping-from-html-metadata)
6. [Handling Embedded CSS and JavaScript](#6-handling-embedded-css-and-javascript)
7. [HTML Preprocessing Before Indexing](#7-html-preprocessing-before-indexing)
8. [Schema Design for HTML Content](#8-schema-design-for-html-content)
9. [Storing vs. Indexing Fields](#9-storing-vs-indexing-fields)
10. [Search Highlighting Against HTML Source](#10-search-highlighting-against-html-source)
11. [Practical Examples: curl and SolrJ](#11-practical-examples-curl-and-solrj)
12. [Common Pitfalls](#12-common-pitfalls)
13. [Reference: ExtractingRequestHandler Parameters](#13-reference-extractingrequesthandler-parameters)

---

## 1. Architecture Overview

Solr does not parse HTML natively. HTML content enters the index through one of two paths:

**Path A — Solr Cell (ExtractingRequestHandler + Tika Server)**
You submit raw HTML (or any binary document) to the `/update/extract` handler. Solr delegates extraction to an external Apache Tika Server process, which parses the HTML into a structured XHTML representation and a set of key/value metadata fields. Solr then maps those fields into its schema and indexes the result.

**Path B — Pre-processed JSON/XML**
You extract text and metadata yourself (using Tika, Jsoup, BeautifulSoup, or any HTML parser), produce clean structured data, and submit it to Solr's standard `/update` handler as JSON or XML. This is the recommended production approach.

Path A is the quickest way to get started. Path B gives you full control and is what most production systems use. The two are not mutually exclusive — many pipelines use Tika externally (Path B architecture) but submit results via the same Solr Cell handler parameters.

```
                        ┌──────────────────────────────────┐
  Raw HTML file         │           Tika Server             │
  ──────────────► POST  │  (external process, port 9998)   │
  /update/extract       │  - Charset detection              │
                        │  - TagSoup HTML parser            │
                        │  - XHTML normalization            │
                        │  - Metadata extraction            │
                        └────────────┬─────────────────────┘
                                     │  structured doc
                                     ▼
                        ┌──────────────────────────────────┐
                        │    ExtractingRequestHandler      │
                        │  - fmap field mapping            │
                        │  - capture element extraction    │
                        │  - lowernames normalization      │
                        │  - literal value injection       │
                        └────────────┬─────────────────────┘
                                     │  SolrInputDocument
                                     ▼
                        ┌──────────────────────────────────┐
                        │   Update Request Processor Chain │
                        │   → Lucene Index                 │
                        └──────────────────────────────────┘
```

---

## 2. Enabling the Extraction Module

The extraction module is **not enabled by default** in Solr 9.x. In Solr 9, all `<lib>` directives were removed from the default configset, so you must opt in explicitly.

### Method 1: Environment variable (recommended)

In `solr.in.sh` (Linux/macOS) or `solr.in.cmd` (Windows):

```bash
SOLR_MODULES=extraction
```

Or pass it at startup:

```bash
bin/solr start -Dsolr.modules=extraction
```

To enable multiple modules:

```bash
SOLR_MODULES=extraction,langid,ltr
```

### Method 2: solr.xml

In `$SOLR_HOME/solr.xml`:

```xml
<solr>
  <str name="modules">extraction</str>
</solr>
```

### Method 3: lib directive in solrconfig.xml (Solr 9.0–9.7)

```xml
<lib dir="${solr.install.dir:../../../..}/modules/extraction/lib" regex=".*\.jar" />
```

**Solr 9.8+ note:** `<lib>` directives became opt-in in 9.8. If you use this approach on 9.8+, you must also set `-Dsolr.config.lib.enabled=true` or Solr will silently ignore the directive.

### Starting the Tika Server

Solr 9 delegates extraction to an **external** Tika Server. The easiest way to run it:

```bash
# Docker (recommended)
docker run --rm -p 9998:9998 --name tika -d apache/tika:3.2.3.0-full

# Or download and run directly
java -jar tika-server-standard-3.x.x.jar --port 9998
```

If both Solr and Tika run in Docker on the same network:

```yaml
# docker-compose.yml excerpt
services:
  tika:
    image: apache/tika:3.2.3.0-full
    ports:
      - "9998:9998"
  solr:
    image: solr:9
    environment:
      - SOLR_MODULES=extraction
    depends_on:
      - tika
```

Configure the Tika Server URL in `solrconfig.xml`:

```xml
<requestHandler name="/update/extract"
                startup="lazy"
                class="solr.extraction.ExtractingRequestHandler">
  <lst name="defaults">
    <str name="tikaserver.url">http://tika:9998</str>
    <str name="lowernames">true</str>
    <str name="fmap.content">body_txt_en</str>
    <str name="uprefix">ignored_</str>
  </lst>
</requestHandler>
```

---

## 3. How Solr Ingests HTML: Tika and ExtractingRequestHandler

### What Tika does with HTML

Apache Tika uses **TagSoup** to parse HTML. TagSoup is a SAX-compliant HTML parser that handles malformed, tag-soup HTML gracefully — it will correct unclosed tags, missing quotes, and other common errors rather than failing. Tika then normalizes the parsed content into well-formed XHTML and serializes it for Solr to process.

The XHTML output looks like:

```xml
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>My Page</title>
  </head>
  <body>
    <h1>Main Heading</h1>
    <p>Body text here.</p>
  </body>
</html>
```

This XHTML representation is what the `capture`, `xpath`, and `captureAttr` parameters operate against.

### What gets extracted

Tika produces two things from an HTML document:

1. **Content text** — all visible text nodes concatenated, stored in a field named `content` (by convention, remapped to `_text_` or a custom field via `fmap.content`).

2. **Metadata** — key/value pairs extracted from the document. For HTML, these come from `<meta>` tags and standard HTML conventions:

| Tika metadata key         | HTML source                             |
|---------------------------|-----------------------------------------|
| `title`                   | `<title>` element                       |
| `dc:title`                | `<title>` or OG meta tags              |
| `description`             | `<meta name="description">`            |
| `keywords`                | `<meta name="keywords">`               |
| `author`                  | `<meta name="author">`                 |
| `Content-Type`            | Always set; typically `text/html`      |
| `Content-Encoding`        | Charset detected by Tika               |
| `og:title`                | `<meta property="og:title">`           |
| `og:description`          | `<meta property="og:description">`     |
| `dc:subject`              | `<meta name="subject">`                |
| `stream_name`             | Filename (set by Solr Cell)            |
| `stream_content_type`     | MIME type (set by Solr Cell)           |

Metadata field names may vary slightly depending on the Tika version and the HTML document's meta tag conventions. Use `extractOnly=true` (described in section 11) to inspect exactly what Tika produces for a given document.

### The content field

By default, Tika concatenates all text nodes from the XHTML body into a single `content` field. Heading text, paragraph text, link text, alt attributes on images, and table cell content all end up merged together with whitespace separating them.

This default is fine for basic full-text search. For richer relevance (e.g., boosting matches in headings over body text), use the `capture` parameter to extract specific elements into separate fields.

---

## 4. Stripping HTML Tags vs. Indexing Raw HTML

There are three distinct strategies, each with different trade-offs.

### Strategy 1: Strip tags at analysis time with HTMLStripCharFilterFactory

The field type itself strips HTML during analysis. The raw HTML is **stored** as-is, but the index sees clean text.

```xml
<fieldType name="text_html_stripped" class="solr.TextField"
           positionIncrementGap="100">
  <analyzer type="index">
    <charFilter class="solr.HTMLStripCharFilterFactory"/>
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.StopFilterFactory" ignoreCase="true"
            words="lang/stopwords_en.txt"/>
    <filter class="solr.SynonymGraphFilterFactory"
            synonyms="synonyms.txt" ignoreCase="true" expand="true"/>
    <filter class="solr.FlattenGraphFilterFactory"/>
  </analyzer>
  <analyzer type="query">
    <!-- No HTMLStripCharFilter on query side — query text is plain -->
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.StopFilterFactory" ignoreCase="true"
            words="lang/stopwords_en.txt"/>
    <filter class="solr.SynonymGraphFilterFactory"
            synonyms="synonyms.txt" ignoreCase="true" expand="false"/>
  </analyzer>
</fieldType>
```

**Pros:** Simple. No preprocessing pipeline needed. Store the full HTML in Solr and let the analyzer handle it.

**Cons:** Highlighting against HTML source has nuance (see section 10). The `HTMLStripCharFilter` preserves character offsets so that highlighting still works, but the returned snippet will contain raw HTML tags that you must handle in your UI.

**When to use:** You want to store raw HTML in Solr and render it in search results, but still need full-text search against the stripped text.

### Strategy 2: Pre-strip HTML before indexing

Strip HTML outside of Solr (using Jsoup, Python's html.parser, etc.), then submit clean plain text. The Solr field type uses a standard text analyzer with no `HTMLStripCharFilter`.

```xml
<fieldType name="text_en" class="solr.TextField"
           positionIncrementGap="100">
  <analyzer>
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.StopFilterFactory" ignoreCase="true"
            words="lang/stopwords_en.txt"/>
    <filter class="solr.EnglishPossessiveFilterFactory"/>
    <filter class="solr.PorterStemFilterFactory"/>
  </analyzer>
</fieldType>
```

**Pros:** Maximum control. Clean, stemmed, full-text search. Highlighting works cleanly against plain text.

**Cons:** Requires an external preprocessing step. The original HTML must be stored separately if you want to render it.

**When to use:** Production systems where you control the ingest pipeline.

### Strategy 3: Store raw HTML, index stripped text in a separate field

Use two fields per document: one stores the raw HTML (`stored=true`, `indexed=false`), and another stores the stripped body text for searching and highlighting.

```xml
<!-- Store raw HTML for rendering, never searched -->
<field name="html_raw" type="string" indexed="false" stored="true"/>

<!-- Clean text for search and highlighting -->
<field name="body_text" type="text_en" indexed="true" stored="true"/>
```

This is the most flexible approach and what most production systems end up doing.

### Preserving specific tags with HTMLStripCharFilter

Sometimes you want to strip most HTML but keep some structural tags (e.g., `<br>`, `<p>`) for display. Use the `escapedTags` attribute:

```xml
<charFilter class="solr.HTMLStripCharFilterFactory" escapedTags="b,em,strong,p"/>
```

The listed tags will be converted to their escaped form (`&lt;b&gt;`) rather than stripped entirely, so they survive into the stored value and can be rendered conditionally.

---

## 5. Field Mapping from HTML Metadata

### The fmap parameter

The `fmap` parameter maps a Tika-generated field name to a Solr schema field name:

```
fmap.<tika-field>=<solr-field>
```

Multiple `fmap` parameters can be passed per request.

**Via curl request parameters:**

```bash
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=page-001\
&fmap.content=body_txt_en\
&fmap.title=title_s\
&fmap.description=description_t\
&fmap.keywords=keywords_txt_en\
&fmap.author=author_s\
&commit=true" \
  -F "file=@page.html"
```

**Via solrconfig.xml defaults (applied to every request):**

```xml
<requestHandler name="/update/extract"
                startup="lazy"
                class="solr.extraction.ExtractingRequestHandler">
  <lst name="defaults">
    <str name="tikaserver.url">http://localhost:9998</str>
    <str name="lowernames">true</str>
    <str name="fmap.content">body_txt_en</str>
    <str name="fmap.title">title_s</str>
    <str name="fmap.description">description_txt_en</str>
    <str name="fmap.keywords">keywords_txt_en</str>
    <str name="fmap.author">author_s</str>
    <str name="uprefix">ignored_</str>
  </lst>
</requestHandler>
```

### Capturing specific HTML elements

The `capture` parameter extracts content from specific XHTML elements into separate fields. The content is *also* included in the main `content` field — capture is additive, not exclusive.

```bash
# Capture <h1> content into a separate field, then map it
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=page-002\
&capture=h1\
&capture=h2\
&capture=p\
&fmap.h1=heading_primary_txt\
&fmap.h2=heading_secondary_txt\
&fmap.p=paragraphs_txt\
&fmap.content=body_txt_en\
&commit=true" \
  -F "file=@page.html"
```

**Important:** When multiple `<h1>` elements exist, their text is concatenated into a single multivalued field value. If your schema field is `multiValued="false"`, only the first value is kept. Use `multiValued="true"` for captured heading fields.

### Capturing link attributes

Use `captureAttr=true` to extract HTML element attributes (like `href` on anchor tags) into separate Solr fields:

```bash
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=page-003\
&capture=a\
&captureAttr=true\
&fmap.a=link_text_txt\
&commit=true" \
  -F "file=@page.html"
```

This indexes anchor text and href values separately, useful for link-graph analysis or anchor-text boosting.

### XPath-based content restriction

The `xpath` parameter restricts which parts of the Tika XHTML are included in the `content` field. The XPath is evaluated against the XHTML namespace:

```bash
# Index only the body text, ignoring header/footer navigation
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=page-004\
&xpath=/xhtml:html/xhtml:body//node()\
&commit=true" \
  -F "file=@page.html"
```

```bash
# Index only h1 and paragraph content
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=page-005\
&xpath=/xhtml:html/xhtml:body/xhtml:h1//node()|/xhtml:html/xhtml:body//xhtml:p//node()\
&commit=true" \
  -F "file=@page.html"
```

Note: The `xhtml:` namespace prefix is required in XPath expressions because Tika produces fully namespace-qualified XHTML.

### Injecting literal values

Use `literal.<fieldname>=<value>` to inject fixed values at index time. Literal values override Tika-extracted values by default (`literalsOverride=true`):

```bash
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=page-006\
&literal.site_section=documentation\
&literal.language=en\
&literal.indexed_by=crawler-v2\
&commit=true" \
  -F "file=@page.html"
```

To append literal values to Tika-extracted values instead of replacing them:

```bash
&literalsOverride=false
```

### Handling unknown metadata fields

Tika produces many metadata fields depending on the HTML document (Open Graph tags, Twitter Card tags, schema.org microdata, etc.). Two parameters control what happens to fields not in your schema:

- `uprefix=ignored_` — prefixes unknown fields so they match a dynamic field like `ignored_*` (which is `stored=false, indexed=false` by convention)
- `defaultField=catch_all_txt` — routes all unknown fields to a single field

Using `uprefix=ignored_` with a catch-all dynamic field is the most common pattern:

```xml
<!-- In managed-schema -->
<dynamicField name="ignored_*" type="ignored" multiValued="true"/>
<fieldType name="ignored" stored="false" indexed="false"
           multiValued="true" class="solr.StrField"/>
```

---

## 6. Handling Embedded CSS and JavaScript

This is one of the most important aspects of HTML indexing and is easy to get wrong.

### What Tika does by default

Tika's HTML parser (TagSoup + HTML SAX handler) **strips the content of `<script>` and `<style>` elements by default**. These are treated as opaque content blocks and their text is not emitted into the XHTML content stream. You do not need to do anything special to prevent CSS or JS from polluting your index.

This means a page like:

```html
<html>
  <head>
    <style>body { color: red; }</style>
    <script>var x = 1;</script>
  </head>
  <body>
    <p>Hello world</p>
    <script>document.write("injected");</script>
  </body>
</html>
```

produces content text of approximately: `Hello world`

### Inline event handlers

Attribute-based JavaScript (e.g., `onclick="doSomething()"`) is handled differently. When `captureAttr=true` is set, these attribute values may be captured. Avoid using `captureAttr=true` without filtering if you don't want JS snippets in your index.

### When you pre-process HTML yourself

If you strip HTML with an external tool before submitting to Solr, make sure to remove `<script>` and `<style>` blocks **before** stripping tags — otherwise the CSS/JS text content ends up merged into your body text. The order matters:

```python
# Correct order with BeautifulSoup
from bs4 import BeautifulSoup

soup = BeautifulSoup(html_content, "html.parser")

# Step 1: Remove script and style elements entirely
for tag in soup(["script", "style", "noscript", "template"]):
    tag.decompose()

# Step 2: Extract clean text
text = soup.get_text(separator=" ", strip=True)
```

If you skip step 1 and go straight to `get_text()`, the CSS and JS source code ends up in your text body.

### HTMLStripCharFilterFactory and script/style

The Solr `HTMLStripCharFilterFactory` also removes `<script>` and `<style>` content, consistent with Tika's behavior. If you are storing raw HTML in a field with an HTML-stripping analyzer, the filter handles this correctly.

---

## 7. HTML Preprocessing Before Indexing

### Why preprocess?

For production workloads, preprocessing HTML before sending it to Solr avoids:
- Tika crashes taking down your indexing pipeline
- CSS/JS noise if Tika behavior changes
- Loss of control over field structure
- Memory exhaustion on very large HTML files

### Recommended preprocessing pipeline

```
Raw HTML
   │
   ▼
1. Charset detection & normalization (ensure UTF-8)
   │
   ▼
2. Remove script, style, noscript, template elements
   │
   ▼
3. Extract metadata (title, description, keywords, OG tags)
   │
   ▼
4. Extract structured content (h1, h2, body paragraphs)
   │
   ▼
5. Strip remaining tags → clean body text
   │
   ▼
6. Normalize whitespace (collapse runs of spaces/newlines)
   │
   ▼
7. Decode remaining HTML entities (&amp; → &, &nbsp; → space)
   │
   ▼
8. Submit structured JSON/XML document to Solr /update
```

### Charset detection

HTML charset issues are among the most common indexing failures. Always detect and normalize charset before processing:

```python
import chardet
from bs4 import BeautifulSoup

# Detect charset from raw bytes
raw_bytes = open("page.html", "rb").read()
detected = chardet.detect(raw_bytes)
encoding = detected.get("encoding", "utf-8") or "utf-8"

# Decode to string
html_str = raw_bytes.decode(encoding, errors="replace")

# OR let BeautifulSoup handle it (it reads the meta charset tag)
soup = BeautifulSoup(raw_bytes, "html.parser")
```

**Never** assume UTF-8 for HTML files from the open web. A significant fraction of older pages are ISO-8859-1, Windows-1252, or GB2312.

### Handling HTML entities

HTML entities must be decoded before indexing, otherwise queries for "naïve" won't match content stored as `"na&iuml;ve"`. Most HTML parsers handle this automatically. If you're processing text extracted from an HTML parser, entities should already be decoded. If you're working with raw strings:

```python
import html
text = html.unescape("na&iuml;ve &amp; so on")
# → "naïve & so on"
```

### Solr Update Request Processors for post-ingest processing

If you need to apply transformations after the document enters Solr but before it's committed to the index, use Update Request Processor (URP) chains:

```xml
<!-- solrconfig.xml -->
<updateRequestProcessorChain name="html-processing">
  <!-- Trim whitespace from all string fields -->
  <processor class="solr.TrimFieldUpdateProcessorFactory"/>

  <!-- Language detection — writes detected lang to "language" field -->
  <processor class="org.apache.solr.update.processor.LangDetectLanguageIdentifierUpdateProcessorFactory">
    <lst name="defaults">
      <str name="langid.fl">title_s,body_txt</str>
      <str name="langid.langField">language_s</str>
      <bool name="langid.map">true</bool>
    </lst>
  </processor>

  <!-- Standard logging and run -->
  <processor class="solr.LogUpdateProcessorFactory"/>
  <processor class="solr.RunUpdateProcessorFactory"/>
</updateRequestProcessorChain>
```

Attach this chain to the extract handler:

```xml
<requestHandler name="/update/extract"
                class="solr.extraction.ExtractingRequestHandler">
  <lst name="defaults">
    <str name="update.chain">html-processing</str>
    <str name="tikaserver.url">http://localhost:9998</str>
    <!-- ... other params -->
  </lst>
</requestHandler>
```

---

## 8. Schema Design for HTML Content

### Complete managed-schema example for HTML documents

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<schema name="html-content" version="1.6">

  <!-- ================================================================
       FIELD TYPES
       ================================================================ -->

  <!-- Non-analyzed string: exact match, sorting, faceting -->
  <fieldType name="string" class="solr.StrField" sortMissingLast="true"
             docValues="true"/>

  <!-- Full-text English: indexed and stored, good for highlighting -->
  <fieldType name="text_en" class="solr.TextField" positionIncrementGap="100">
    <analyzer type="index">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.StopFilterFactory" ignoreCase="true"
              words="lang/stopwords_en.txt" format="snowball"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.EnglishPossessiveFilterFactory"/>
      <filter class="solr.KeywordMarkerFilterFactory" protected="protwords.txt"/>
      <filter class="solr.PorterStemFilterFactory"/>
    </analyzer>
    <analyzer type="query">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.SynonymGraphFilterFactory" synonyms="synonyms.txt"
              ignoreCase="true" expand="true"/>
      <filter class="solr.StopFilterFactory" ignoreCase="true"
              words="lang/stopwords_en.txt" format="snowball"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.EnglishPossessiveFilterFactory"/>
      <filter class="solr.KeywordMarkerFilterFactory" protected="protwords.txt"/>
      <filter class="solr.PorterStemFilterFactory"/>
    </analyzer>
  </fieldType>

  <!-- Full-text with HTML stripping: store raw HTML, search stripped text.
       Only use HTMLStripCharFilter on the INDEX side.
       Query text is plain — do not strip the query. -->
  <fieldType name="text_html" class="solr.TextField" positionIncrementGap="100">
    <analyzer type="index">
      <charFilter class="solr.HTMLStripCharFilterFactory"/>
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.StopFilterFactory" ignoreCase="true"
              words="lang/stopwords_en.txt"/>
    </analyzer>
    <analyzer type="query">
      <!-- No HTMLStripCharFilter here — queries are plain text -->
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.StopFilterFactory" ignoreCase="true"
              words="lang/stopwords_en.txt"/>
    </analyzer>
  </fieldType>

  <!-- Date: ISO 8601 format -->
  <fieldType name="pdate" class="solr.DatePointField" docValues="true"/>

  <!-- Long integer for sizes, counts -->
  <fieldType name="plong" class="solr.LongPointField" docValues="true"/>

  <!-- Ignored: accepts anything, stores/indexes nothing -->
  <fieldType name="ignored" stored="false" indexed="false"
             multiValued="true" class="solr.StrField"/>


  <!-- ================================================================
       FIELDS
       ================================================================ -->

  <!-- Required: unique document identifier (URL or URL hash) -->
  <field name="id"              type="string"   indexed="true"  stored="true"
                                required="true" multiValued="false"/>

  <!-- Document URL — exact match, stored for display -->
  <field name="url"             type="string"   indexed="true"  stored="true"/>

  <!-- Page title from <title> element or dc:title metadata.
       Stored for display. Indexed for search. Short string — no stemming.
       Use a separate text_en field if you want stemmed title search. -->
  <field name="title_s"         type="string"   indexed="true"  stored="true"/>
  <field name="title_txt"       type="text_en"  indexed="true"  stored="false"/>

  <!-- Meta description — stored for display snippets, also searched -->
  <field name="description_txt" type="text_en"  indexed="true"  stored="true"/>

  <!-- Keywords from <meta name="keywords"> -->
  <field name="keywords_txt"    type="text_en"  indexed="true"  stored="true"
                                multiValued="true"/>

  <!-- Author from <meta name="author"> -->
  <field name="author_s"        type="string"   indexed="true"  stored="true"/>

  <!-- Primary heading text (from <h1> via capture parameter) -->
  <field name="h1_txt"          type="text_en"  indexed="true"  stored="true"
                                multiValued="true"/>

  <!-- Secondary headings (from <h2>, <h3> via capture) -->
  <field name="h2_txt"          type="text_en"  indexed="true"  stored="true"
                                multiValued="true"/>

  <!-- Main body text — stripped of HTML, indexed and stored for highlighting.
       This is the primary full-text search field. -->
  <field name="body_txt"        type="text_en"  indexed="true"  stored="true"
                                termVectors="true" termPositions="true"
                                termOffsets="true"/>

  <!-- Raw HTML — stored only, never searched.
       Use for rendering the page in search results. -->
  <field name="html_raw"        type="string"   indexed="false" stored="true"/>

  <!-- Language detected by LangDetect URP -->
  <field name="language_s"      type="string"   indexed="true"  stored="true"/>

  <!-- Content-Type from Tika (e.g., "text/html; charset=UTF-8") -->
  <field name="content_type_s"  type="string"   indexed="true"  stored="true"/>

  <!-- Site section or category — injected as literal -->
  <field name="site_section_s"  type="string"   indexed="true"  stored="true"
                                docValues="true"/>

  <!-- Index timestamp -->
  <field name="indexed_at_dt"   type="pdate"    indexed="true"  stored="true"
                                docValues="true" default="NOW"/>

  <!-- Page last modified (from HTTP headers, if available) -->
  <field name="last_modified_dt" type="pdate"   indexed="true"  stored="true"
                                 docValues="true"/>

  <!-- Page size in bytes -->
  <field name="file_size_l"     type="plong"    indexed="true"  stored="true"
                                docValues="true"/>

  <!-- Copy field: all searchable text routes to _text_ for default search -->
  <field name="_text_"          type="text_en"  indexed="true"  stored="false"
                                multiValued="true"/>

  <!-- ================================================================
       DYNAMIC FIELDS
       ================================================================ -->

  <!-- Catch-all for unknown Tika metadata (via uprefix=ignored_) -->
  <dynamicField name="ignored_*" type="ignored" multiValued="true"/>

  <!-- Typed dynamic fields for extension -->
  <dynamicField name="*_s"      type="string"   indexed="true"  stored="true"/>
  <dynamicField name="*_txt"    type="text_en"  indexed="true"  stored="true"/>
  <dynamicField name="*_dt"     type="pdate"    indexed="true"  stored="true"/>
  <dynamicField name="*_l"      type="plong"    indexed="true"  stored="true"/>
  <dynamicField name="*_b"      type="boolean"  indexed="true"  stored="true"/>


  <!-- ================================================================
       COPY FIELDS: feed into _text_ for default search
       ================================================================ -->

  <copyField source="title_s"        dest="_text_"/>
  <copyField source="title_txt"      dest="_text_"/>
  <copyField source="description_txt" dest="_text_"/>
  <copyField source="keywords_txt"   dest="_text_"/>
  <copyField source="h1_txt"         dest="_text_"/>
  <copyField source="h2_txt"         dest="_text_"/>
  <copyField source="body_txt"       dest="_text_"/>


  <!-- ================================================================
       UNIQUE KEY
       ================================================================ -->

  <uniqueKey>id</uniqueKey>

</schema>
```

### Schema API equivalent (managed-schema via REST)

If using Schemaless/API-managed schema, add fields via the Schema API:

```bash
# Add the body_txt field with term vectors for highlighting
curl -X POST http://localhost:8983/solr/mycore/schema \
  -H "Content-Type: application/json" \
  -d '{
    "add-field": {
      "name": "body_txt",
      "type": "text_en",
      "indexed": true,
      "stored": true,
      "termVectors": true,
      "termPositions": true,
      "termOffsets": true
    }
  }'

# Add a copy field
curl -X POST http://localhost:8983/solr/mycore/schema \
  -H "Content-Type: application/json" \
  -d '{
    "add-copy-field": {
      "source": "body_txt",
      "dest": "_text_"
    }
  }'
```

---

## 9. Storing vs. Indexing Fields

Understanding when to use `indexed`, `stored`, `docValues`, and term vector options is critical for HTML use cases.

### Decision matrix

| Need | indexed | stored | docValues | termVectors |
|------|---------|--------|-----------|-------------|
| Full-text search | true | — | — | — |
| Return in results | — | true | — | — |
| Sorting / faceting (text) | — | — | true | — |
| Sorting / faceting (string) | — | — | true | — |
| Highlighting (basic) | true | true | — | — |
| Highlighting (fast, large docs) | true | true | — | true + positions + offsets |
| Phrase queries | true | — | — | true + positions |
| Wildcard highlighting fallback | true | true | — | true |
| Raw HTML storage only | false | true | — | — |
| Never needed (catch-all) | false | false | — | — |

### HTML-specific field decisions

**`body_txt` (main body text):** `indexed=true`, `stored=true`. If documents are long (blog posts, articles), add `termVectors=true`, `termPositions=true`, `termOffsets=true` — this trades disk space for faster highlighting. The Unified Highlighter recommends `storeOffsetsWithPositions=true` as a middle-ground option.

```xml
<field name="body_txt" type="text_en" indexed="true" stored="true"
       termVectors="true" termPositions="true" termOffsets="true"/>
```

**`html_raw` (raw HTML storage):** `indexed=false`, `stored=true`. Never index raw HTML directly — the noise from tags, attributes, and CSS classes overwhelms the text signal and bloats the index.

```xml
<field name="html_raw" type="string" indexed="false" stored="true"/>
```

**`title_s` (page title):** `indexed=true`, `stored=true`, `docValues=true`. The `docValues=true` setting enables fast sorting and faceting. For title search (not just exact match), also use `title_txt` with a text analyzer, or use `copyField` to feed `title_s` into a text field.

```xml
<field name="title_s" type="string" indexed="true" stored="true" docValues="true"/>
<copyField source="title_s" dest="title_txt"/>
```

**`keywords_txt`:** `multiValued=true`. HTML `<meta name="keywords">` can contain comma-separated values, and different meta tags may produce multiple keyword fields.

**`url`:** `indexed=true`, `stored=true`, but **do not apply text analysis** — use `type="string"` so URLs are matched exactly, not tokenized.

### DocValues vs. stored fields for retrieval

DocValues are stored in a column-oriented format optimized for sorting and faceting. They are **not** a substitute for `stored=true` when you need to return field values in search results — though Solr can be configured to use docValues for retrieval via `useDocValuesAsStored=true`.

For HTML content fields (`body_txt`, `description_txt`), do not use docValues — the text is too large and variable. Use `stored=true` for retrieval and term vectors for efficient highlighting.

---

## 10. Search Highlighting Against HTML Source

Solr 9.x ships three highlighters: **Unified** (recommended), **Original**, and **FastVector**.

### The HTML highlighting challenge

When the stored field contains raw HTML, the highlighter will return snippets that include HTML tags. Depending on your use case, this is either desired (you want to render the highlighted HTML) or a problem (you get `<em>foo</em> is a <strong>term</strong>` instead of a clean snippet).

**Option A: Highlight against `body_txt` (plain text)**

Store pre-stripped body text in `body_txt` (plain text, no HTML tags). Highlight against this field. The snippets are clean and safe to render directly.

```
GET /solr/mycore/select?q=foo+bar
  &hl=true
  &hl.method=unified
  &hl.fl=body_txt,title_txt
  &hl.fragsize=200
  &hl.snippets=3
  &hl.tag.pre=<em>
  &hl.tag.post=</em>
  &hl.encoder=html
```

**Option B: Highlight against `html_raw` with `text_html` field type**

If the field uses `HTMLStripCharFilterFactory`, Solr's highlighter strips the HTML during offset calculation and returns highlighted snippets from the stripped text. The `HTMLStripCharFilter` preserves character offsets, so positions in the stripped text map back to positions in the raw HTML — this is what makes highlighting with raw HTML fields work at all.

Note: the snippets returned by the highlighter will contain plain text with your highlight tags, even though the stored value is raw HTML.

### Unified Highlighter configuration

The Unified Highlighter is the default and best-performing option in Solr 9.x:

```
hl=true
hl.method=unified
hl.fl=body_txt,description_txt,h1_txt
hl.fragsize=150
hl.snippets=2
hl.tag.pre=<mark>
hl.tag.post=</mark>
hl.encoder=html
hl.offsetSource=POSTINGS
```

Offset source recommendations for HTML content:

| `hl.offsetSource` | Index overhead | Speed | Best for |
|-------------------|----------------|-------|----------|
| `ANALYSIS` | None | Slowest | Short fields, low query volume |
| `POSTINGS` | Small (storeOffsetsWithPositions=true) | Fast | Long body text |
| `POSTINGS_WITH_TERM_VECTORS` | Medium | Very fast | Wildcard queries |
| `TERM_VECTORS` | Large | Fastest | High-volume, large docs |

For large HTML documents (articles, pages with many paragraphs), use `POSTINGS` or `TERM_VECTORS`:

```xml
<!-- Schema: enable postings offset for large content -->
<field name="body_txt" type="text_en" indexed="true" stored="true"
       storeOffsetsWithPositions="true"/>
```

### FastVector Highlighter for multi-term coloring

```
hl=true
hl.method=fastVector
hl.fl=body_txt
hl.fragsize=200
hl.snippets=3
hl.tag.pre=<em class="hl-1">
hl.tag.post=</em>
hl.mergeContiguous=true
```

FastVector requires full term vector configuration:

```xml
<field name="body_txt" type="text_en" indexed="true" stored="true"
       termVectors="true" termPositions="true" termOffsets="true"/>
```

### Preventing XSS in highlighted HTML

When highlighting against user-supplied queries and displaying results in a web UI, always set `hl.encoder=html`. This encodes special characters in the snippet text (`<`, `>`, `&`, `"`) as HTML entities, while leaving your highlight pre/post tags (`<em>`, `</em>`) unencoded. Without this setting, a crafted query could inject HTML into your search results page.

```
hl.encoder=html
hl.tag.pre=<em>
hl.tag.post=</em>
```

With these settings, the following content:
```
The <script>alert("xss")</script> attack
```
produces a snippet like:
```
The &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; <em>attack</em>
```

---

## 11. Practical Examples: curl and SolrJ

### curl: Submit HTML file via Solr Cell

```bash
# Basic HTML file indexing
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=doc-001\
&fmap.content=body_txt\
&fmap.title=title_s\
&fmap.description=description_txt\
&fmap.keywords=keywords_txt\
&uprefix=ignored_\
&lowernames=true\
&commit=true" \
  -F "file=@/path/to/page.html;type=text/html"
```

### curl: Debug extraction without indexing

Use `extractOnly=true` to see exactly what Tika produces from an HTML file, without writing anything to the index:

```bash
# Get XHTML output (default)
curl "http://localhost:8983/solr/mycore/update/extract?\
extractOnly=true\
&extractFormat=xml\
&wt=json" \
  --data-binary @page.html \
  -H "Content-type: text/html"

# Get plain text output
curl "http://localhost:8983/solr/mycore/update/extract?\
extractOnly=true\
&extractFormat=text\
&wt=json" \
  --data-binary @page.html \
  -H "Content-type: text/html"
```

The JSON response includes the extracted content and all metadata fields Tika detected. Use this to identify what `fmap` parameters you need.

### curl: Submit HTML with element capture

```bash
curl "http://localhost:8983/solr/mycore/update/extract?\
literal.id=doc-002\
&capture=h1\
&capture=h2\
&fmap.h1=h1_txt\
&fmap.h2=h2_txt\
&fmap.content=body_txt\
&fmap.title=title_s\
&uprefix=ignored_\
&commit=true" \
  -F "file=@/path/to/page.html;type=text/html"
```

### curl: Submit pre-processed HTML as JSON

This is the production approach — strip and structure HTML externally, then submit JSON:

```bash
curl -X POST "http://localhost:8983/solr/mycore/update?commit=true" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "id": "page-003",
      "url": "https://example.com/blog/post-1",
      "title_s": "My Blog Post",
      "title_txt": "My Blog Post",
      "description_txt": "An article about Solr indexing strategies.",
      "keywords_txt": ["solr", "search", "indexing"],
      "h1_txt": ["Solr Indexing Strategies"],
      "h2_txt": ["Introduction", "Configuration", "Testing"],
      "body_txt": "Full page body text with all HTML stripped out...",
      "language_s": "en",
      "site_section_s": "blog",
      "indexed_at_dt": "NOW"
    }
  ]'
```

### SolrJ: Index HTML file with ContentStreamUpdateRequest (Solr 9.x)

```java
import org.apache.solr.client.solrj.SolrClient;
import org.apache.solr.client.solrj.impl.Http2SolrClient;
import org.apache.solr.client.solrj.request.AbstractUpdateRequest;
import org.apache.solr.client.solrj.request.ContentStreamUpdateRequest;
import org.apache.solr.common.util.NamedList;

import java.io.File;
import java.io.IOException;

public class HtmlIndexer {

    private static final String SOLR_URL = "http://localhost:8983/solr/mycore";

    public static void indexHtmlFile(File htmlFile, String docId)
            throws Exception {

        // Http2SolrClient is the recommended client in Solr 9.x
        try (SolrClient solr = new Http2SolrClient.Builder(SOLR_URL).build()) {

            ContentStreamUpdateRequest req =
                new ContentStreamUpdateRequest("/update/extract");

            // Add the HTML file with explicit MIME type
            req.addFile(htmlFile, "text/html");

            // Required: document ID
            req.setParam("literal.id", docId);

            // Field mapping
            req.setParam("fmap.content",     "body_txt");
            req.setParam("fmap.title",       "title_s");
            req.setParam("fmap.description", "description_txt");
            req.setParam("fmap.keywords",    "keywords_txt");

            // Element capture
            req.setParam("capture",  "h1");
            req.setParam("capture",  "h2");
            req.setParam("fmap.h1", "h1_txt");
            req.setParam("fmap.h2", "h2_txt");

            // Unknown field handling
            req.setParam("uprefix",    "ignored_");
            req.setParam("lowernames", "true");

            // Literal injection
            req.setParam("literal.site_section_s", "blog");

            // Commit after indexing
            req.setAction(AbstractUpdateRequest.ACTION.COMMIT, true, true);

            NamedList<Object> response = solr.request(req);
            System.out.println("Indexed: " + docId + " → " + response);
        }
    }

    public static void main(String[] args) throws Exception {
        indexHtmlFile(new File("page.html"), "page-001");
    }
}
```

### SolrJ: Submit pre-processed document as SolrInputDocument

For production use, prefer to pre-process HTML and submit a structured document:

```java
import org.apache.solr.client.solrj.SolrClient;
import org.apache.solr.client.solrj.impl.Http2SolrClient;
import org.apache.solr.common.SolrInputDocument;

import java.util.Arrays;
import java.util.List;

public class StructuredHtmlIndexer {

    public static void indexPage(
        String url,
        String title,
        String description,
        List<String> keywords,
        String h1Text,
        String bodyText
    ) throws Exception {

        try (SolrClient solr = new Http2SolrClient.Builder(
                "http://localhost:8983/solr/mycore").build()) {

            SolrInputDocument doc = new SolrInputDocument();

            // Use a URL hash or the URL itself as ID
            doc.addField("id",              hashOf(url));
            doc.addField("url",             url);
            doc.addField("title_s",         title);
            doc.addField("title_txt",       title);
            doc.addField("description_txt", description);
            doc.addField("keywords_txt",    keywords);
            doc.addField("h1_txt",          h1Text);
            doc.addField("body_txt",        bodyText);
            doc.addField("language_s",      "en");
            doc.addField("site_section_s",  "blog");

            solr.add(doc);
            solr.commit();

            System.out.println("Indexed: " + url);
        }
    }

    private static String hashOf(String input) {
        // MD5 or SHA-256 hash of URL for stable IDs
        // use java.security.MessageDigest in real code
        return Integer.toHexString(input.hashCode());
    }
}
```

### SolrJ: Query with highlighting

```java
import org.apache.solr.client.solrj.SolrClient;
import org.apache.solr.client.solrj.SolrQuery;
import org.apache.solr.client.solrj.impl.Http2SolrClient;
import org.apache.solr.client.solrj.response.QueryResponse;
import org.apache.solr.common.SolrDocument;

import java.util.List;
import java.util.Map;

public class HtmlSearch {

    public static void search(String queryText) throws Exception {
        try (SolrClient solr = new Http2SolrClient.Builder(
                "http://localhost:8983/solr/mycore").build()) {

            SolrQuery query = new SolrQuery();
            query.setQuery(queryText);
            query.setFields("id", "url", "title_s", "description_txt");
            query.setRows(10);

            // Enable highlighting
            query.setHighlight(true);
            query.setHighlightSnippets(3);
            query.setHighlightFragsize(150);
            query.addHighlightField("body_txt");
            query.addHighlightField("title_txt");
            query.setParam("hl.method",   "unified");
            query.setParam("hl.tag.pre",  "<em>");
            query.setParam("hl.tag.post", "</em>");
            query.setParam("hl.encoder",  "html");

            QueryResponse response = solr.query(query);

            for (SolrDocument doc : response.getResults()) {
                String id    = (String) doc.getFieldValue("id");
                String title = (String) doc.getFieldValue("title_s");
                System.out.println("--- " + title + " ---");

                // Get highlighting snippets for this document
                Map<String, List<String>> hl = response.getHighlighting().get(id);
                if (hl != null && hl.containsKey("body_txt")) {
                    for (String snippet : hl.get("body_txt")) {
                        System.out.println("  SNIPPET: " + snippet);
                    }
                }
            }
        }
    }
}
```

---

## 12. Common Pitfalls

### Pitfall 1: UTF-8 encoding errors

**Symptom:** `Invalid UTF-8 middle byte 0x3c` or `Invalid UTF-8 character 0xffff`

**Cause:** The HTML file is not UTF-8 encoded. 0x3c is `<` in ASCII — this error typically means the file is UTF-16 and the parser is reading it as UTF-8. 0xffff is the UTF-16 BOM.

**Fix:** Always detect charset before processing. Ensure all content submitted to Solr is UTF-8 encoded. Strip BOM markers from files.

```bash
# Convert file to UTF-8 before indexing
iconv -f windows-1252 -t utf-8 page.html > page_utf8.html

# Python: detect and re-encode
python3 -c "
import chardet
raw = open('page.html', 'rb').read()
enc = chardet.detect(raw)['encoding'] or 'latin-1'
print(raw.decode(enc).encode('utf-8').decode('utf-8'))
" > page_utf8.html
```

### Pitfall 2: HTML entities not decoded

**Symptom:** Searching for "café" doesn't find content stored as `caf&eacute;`

**Cause:** HTML entities were not decoded before (or during) indexing.

**Fix:** Use an HTML parser that decodes entities automatically, or explicitly call `html.unescape()` on extracted text. The `HTMLStripCharFilterFactory` decodes entities during analysis, but only for indexed text — stored raw values retain the entities.

### Pitfall 3: Tags run together after stripping

**Symptom:** "wordAword" (no space) appears in indexed text instead of "wordA word"

**Cause:** Adjacent tags with no whitespace: `<p>wordA</p><p>word</p>` strips to `wordAword`.

**Fix:** When using external HTML stripping, insert a space before stripping tags:

```python
import re
# Insert space before block-level closing tags
text = re.sub(r'</(p|div|li|h[1-6]|br|tr|td|th)[^>]*>', r' </\1>', html)
# Then strip remaining tags
text = re.sub(r'<[^>]+>', '', text)
text = ' '.join(text.split())  # normalize whitespace
```

The `HTMLStripCharFilterFactory` handles this correctly (it substitutes newlines for block-level elements), but external stripping tools often do not.

### Pitfall 4: Tika exhausting memory on large HTML files

**Symptom:** Tika Server OOM or timeout when indexing large HTML files (e.g., single-page apps with huge inline JavaScript blobs)

**Cause:** TagSoup builds a full DOM tree in memory. Very large `<script>` blocks or deeply nested HTML structures can exhaust heap.

**Fix:**
- Pre-strip `<script>` and `<style>` blocks before sending to Tika
- Set `tikaserver.maxChars` to limit the response size
- Set `tikaserver.timeoutSeconds` to prevent hanging
- Use XPath to restrict extraction to the body content only

```xml
<requestHandler name="/update/extract"
                class="solr.extraction.ExtractingRequestHandler">
  <lst name="defaults">
    <str name="tikaserver.url">http://localhost:9998</str>
    <str name="tikaserver.maxChars">500000</str>  <!-- 500k chars max -->
    <str name="tikaserver.timeoutSeconds">30</str>
    <str name="xpath">/xhtml:html/xhtml:body//node()</str>
  </lst>
</requestHandler>
```

### Pitfall 5: Duplicate content from copy fields

**Symptom:** `_text_` field contains the title three times, inflating match scores

**Cause:** `title_s` is copied to `_text_`, `title_txt` is also copied to `_text_`, and `fmap.content=_text_` also routes body content to `_text_`.

**Fix:** Be deliberate about copy field targets. Route body content to `body_txt`, not directly to `_text_`. Let copy fields fan out from `body_txt` to `_text_`.

### Pitfall 6: Heading text missing from captures

**Symptom:** `h1_txt` is empty even though the HTML clearly has `<h1>` elements

**Cause:** The `capture` parameter matches against the Tika XHTML tag names, which may differ from raw HTML. Also, Tika lowercases tag names, and the capture parameter is case-sensitive.

**Fix:** Always use lowercase element names in `capture`. Use `extractOnly=true` to inspect the XHTML Tika produces and verify the tag names.

```bash
# Verify what Tika produces
curl "http://localhost:8983/solr/mycore/update/extract?extractOnly=true&wt=json" \
  --data-binary @page.html -H "Content-type: text/html" \
  | python3 -m json.tool | grep -A5 '"content"'
```

### Pitfall 7: Field name collisions from lowernames=true

**Symptom:** Unexpected field values in Solr documents; some metadata fields missing

**Cause:** `lowernames=true` converts Tika metadata field names to lowercase and replaces hyphens/colons with underscores. This means `Content-Type` becomes `content_type` and `dc:title` becomes `dc_title`. If two metadata keys collapse to the same lowercased name, one value overwrites the other.

**Fix:** Always use `extractOnly=true` with `lowernames=true` to see the actual field names Tika produces for your HTML, then write `fmap` parameters accordingly.

### Pitfall 8: Stored raw HTML exceeds field size limits

**Symptom:** Documents with very large HTML fail to index, or cause Lucene stored field segment issues

**Cause:** Lucene's stored field blocks have a size limit (by default, a single stored field value must fit within a 32KB compressed block). Very large HTML pages (100KB+) can stress this.

**Fix:** For very large HTML, either:
- Store only a truncated version (first 50KB for rendering, the rest is only indexed)
- Store the HTML externally (object storage, database) and keep only a URL reference in Solr
- Compress with a custom stored field compression policy

### Pitfall 9: Highlighting returns empty snippets

**Symptom:** `hl` section in response exists but snippets are empty for `body_txt`

**Causes and fixes:**
- Field is not `stored=true` — the highlighter can't retrieve the text to highlight
- `hl.requireFieldMatch=true` but the query doesn't include `body_txt` in `qf` — remove `hl.requireFieldMatch` or add the field to the query
- The matched term was stemmed differently between index and query analyzers — verify analyzer chains match
- `hl.fragsize` is too large for short documents — set `hl.fragsize=0` to return the entire field

### Pitfall 10: CSS class names indexed as searchable text

**Symptom:** Searching for common class names like "container" or "header" returns unintended results

**Cause:** If using `captureAttr=true` without filtering, HTML element attributes (including `class`, `style`, `data-*`) are captured and indexed.

**Fix:** Do not use `captureAttr=true` unless you specifically need attribute content. If you do use it, route captured attributes to `ignored_*` fields for attributes you don't need.

---

## 13. Reference: ExtractingRequestHandler Parameters

Complete parameter reference for the `ExtractingRequestHandler` (Solr 9.x, extraction module):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tikaserver.url` | — | **Required.** URL of the external Tika Server. |
| `tikaserver.maxChars` | 100MB | Maximum response size from Tika in characters. |
| `tikaserver.timeoutSeconds` | 180 | HTTP timeout for Tika requests. |
| `fmap.<source>` | — | Map Tika field `<source>` to a Solr schema field. Multiple allowed. |
| `literal.<field>` | — | Inject a literal value into a Solr field. Multiple allowed. |
| `literalsOverride` | `true` | If `true`, literal values replace Tika values. If `false`, they append. |
| `lowernames` | `false` | Convert all Tika metadata field names to lowercase with underscores. |
| `uprefix` | — | Prefix unknown Tika fields with this string (e.g., `ignored_`). |
| `defaultField` | — | Route all unknown Tika fields to this single Solr field. |
| `capture` | — | Extract this XHTML element's text into a separate field (also kept in content). Repeatable. |
| `captureAttr` | `false` | Also capture element attributes as separate fields. |
| `xpath` | — | XPath expression (against Tika XHTML) to restrict content extraction. |
| `stream.type` | auto-detected | Override MIME type detection (e.g., `text/html`). |
| `resource.name` | — | Filename hint for MIME type detection. |
| `resource.password` | — | Password for encrypted documents. |
| `passwordsFile` | — | Path to file mapping filename patterns to passwords. |
| `extractOnly` | `false` | Return extracted content without indexing. |
| `extractFormat` | `xml` | Format for `extractOnly=true`: `xml` (XHTML) or `text`. |
| `ignoreTikaException` | `false` | If `true`, index metadata even if content extraction fails. |
| `multipartUploadLimitInKB` | 2048 | Maximum multipart upload size. |
| `update.chain` | default | Name of the Update Request Processor chain to use. |

---

## Sources

- [Apache Solr Reference Guide – Indexing with Tika](https://solr.apache.org/guide/solr/latest/indexing-guide/indexing-with-tika.html)
- [Apache Solr Reference Guide – CharFilters](https://solr.apache.org/guide/solr/latest/indexing-guide/charfilters.html)
- [Apache Solr Reference Guide – Highlighting](https://solr.apache.org/guide/solr/latest/query-guide/highlighting.html)
- [Apache Solr Reference Guide – Schema Elements](https://solr.apache.org/guide/solr/latest/indexing-guide/schema-elements.html)
- [Apache Solr Reference Guide – Solr Modules](https://solr.apache.org/guide/solr/latest/configuration-guide/solr-modules.html)
- [Apache Solr Reference Guide – DocValues](https://solr.apache.org/guide/solr/latest/indexing-guide/docvalues.html)
- [ExtractingParams API Javadoc (Solr 9.7.0)](https://solr.apache.org/docs/9_7_0/modules/extraction/org/apache/solr/handler/extraction/ExtractingParams.html)
- [ContentStreamUpdateRequest API (Solr 9.x)](https://solr.apache.org/docs/9_0_0/solrj/org/apache/solr/client/solrj/request/ContentStreamUpdateRequest.html)
- [CharFilterFactories Reference (Solr 9.3)](https://solr.apache.org/guide/solr/9_3/indexing-guide/charfilterfactories.html)
- [DocValues vs. Stored Fields – Sease.io](https://sease.io/2020/03/docvalues-vs-stored-fields-apache-solr-features-and-performance-smackdown.html)
