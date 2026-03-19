# Solr Fuzzy and Phonetic Search Configuration (Solr 9.x)

This document covers everything needed to configure and tune fuzzy and phonetic search in Apache Solr 9.x, from basic tilde syntax through full schema definitions, query parsers, SpellCheck, and performance considerations.

---

## Table of Contents

1. [Fuzzy Search: Syntax and Edit Distance](#1-fuzzy-search-syntax-and-edit-distance)
2. [Fuzzy Search: Query Time vs. Index Time](#2-fuzzy-search-query-time-vs-index-time)
3. [Phonetic Algorithms: DoubleMetaphone, Soundex, Beider-Morse](#3-phonetic-algorithms)
4. [Phonetic Analysis in Schema: fieldType Definitions](#4-phonetic-analysis-in-schema)
5. [NGram and EdgeNGram for Prefix / Partial Matching](#5-ngram-and-edgengram-for-prefix--partial-matching)
6. [Synonyms with SynonymGraphFilterFactory](#6-synonyms-with-synonymgraphfilterfactory)
7. [SpellCheck Component](#7-spellcheck-component)
8. [Query Parsers: eDisMax vs. DisMax](#8-query-parsers-edismax-vs-dismax)
9. [Boosting and Scoring for Fuzzy Matches](#9-boosting-and-scoring-for-fuzzy-matches)
10. [Practical Example: Full "Fuzzy Search" Field Type](#10-practical-example-full-fuzzy-search-field-type)
11. [Performance Implications](#11-performance-implications)
12. [Testing and Debugging](#12-testing-and-debugging)

---

## 1. Fuzzy Search: Syntax and Edit Distance

Solr's fuzzy search is built on the Damerau-Levenshtein (edit distance) algorithm. The core idea: find index terms within N single-character edits (insertions, deletions, substitutions, transpositions) of the query term.

### Basic Tilde Syntax

Append `~` to a single-word term in any query:

```
# Default edit distance of 2
q=roam~

# Explicit edit distance of 1
q=roam~1

# Edit distance 2 (maximum allowed)
q=roam~2
```

`roam~1` matches: `roam`, `roams`, `foam`, `road`
`roam~2` additionally matches: `foams`, `roads`, `loam`, etc.

The edit distance parameter must be `0`, `1`, or `2`. Values above 2 are not supported by Lucene's FuzzyQuery. Specifying `0` is equivalent to an exact match.

### Phrase Fuzzy Search

The `~` operator applied after a quoted phrase means proximity (slop), not edit distance. For fuzzy multi-word matching, apply the tilde to each word individually or use the eDisMax `mm` parameter:

```
# Proximity search (slop=2) — NOT fuzzy spelling
q="roam foam"~2

# Fuzzy individual terms — two separate fuzzy queries ORed
q=roam~1 foam~1
```

### The Fuzzy Query Parser

For fine-grained control, use Solr's dedicated `{!fuzzy}` local params parser:

```
# Basic usage
q={!fuzzy f=title}roam

# Full parameter control
q={!fuzzy f=title maxEdits=1 prefixLength=3 maxExpansions=50 transpositions=true}roaming
```

| Parameter | Default | Description |
|---|---|---|
| `f` | (required) | Field to search |
| `maxEdits` | `2` | Maximum edits allowed (0–2) |
| `prefixLength` | `0` | Characters at the start that must match exactly |
| `maxExpansions` | `50` | Cap on the number of fuzzy term expansions |
| `transpositions` | `true` | Count transpositions as one edit (Damerau-Levenshtein vs. standard Levenshtein) |

`prefixLength` is the single most important performance knob. Setting it to 2 or 3 dramatically reduces the candidate term space because the first N characters must be exact.

---

## 2. Fuzzy Search: Query Time vs. Index Time

### Query-Time Fuzzy (the Standard Approach)

The `~` operator and `{!fuzzy}` parser work entirely at query time. No special schema configuration is required. The Lucene index is traversed for all terms within edit distance N of the query term. This approach is:

- Zero index overhead
- Slightly more CPU at query time (bounded by `maxExpansions`)
- Flexible — edit distance is a per-query choice

**When to use:** General-purpose fuzzy matching where you do not know in advance which terms will be misspelled, or when your index is small to medium sized.

### Index-Time Fuzzy (via NGrams or Phonetics)

Alternatively, you can "bake in" approximate matching at index time by using NGram or phonetic filters in the field analyzer. The query then becomes an exact match against pre-computed approximate keys. This is:

- Higher index size
- Faster query execution (exact term lookup vs. term enumeration)
- Less flexible — the approximation strategy is fixed at schema design time

**When to use:** Very large indexes where query-time fuzzy is too slow, autocomplete/prefix matching (EdgeNGram), or sound-alike name matching (phonetic).

Both strategies can be combined: index-time phonetics for sound-alike recall, plus query-time fuzzy for typo tolerance.

---

## 3. Phonetic Algorithms

Solr ships with several phonetic encoding algorithms via Lucene's analysis library. Choose based on the language and use case.

### DoubleMetaphone

Developed by Lawrence Philips as an improvement on Metaphone. Generates two encodings per token (primary and alternate) to handle ambiguous pronunciations. Works well for English names.

- "Smith" → SM0, XMT
- "Schmidt" → XMT, SMT

Both encodings are generated and either can match at search time.

### Soundex / Refined Soundex

The original Soundex algorithm (US National Archives standard) reduces a name to one letter plus three digits. Fast and simple, but imprecise.

- "Robert" → R163
- "Rupert" → R163

**Refined Soundex** is more precise, assigns codes to more consonants, and produces variable-length codes.

Use Soundex only when you need maximum simplicity and are okay with high false-positive rates.

### Beider-Morse Phonetic Matching (BMPM)

The most sophisticated algorithm available in Solr. Developed by Alexander Beider and Stephen Morse, it:

- Supports 12+ languages including English, French, German, Hebrew, Russian, Spanish
- Detects the likely language of a name and applies language-appropriate phonetic rules
- Generates multiple encodings per name
- Handles multi-language name variants (e.g., Jewish surnames spelled differently across European languages)

BMPM is the right choice for multi-language personal name matching. It is more expensive than Soundex/Metaphone but produces substantially fewer false positives and fewer false negatives.

### Daitch-Mokotoff Soundex

A refinement of Soundex optimized for Slavic and Yiddish surnames. Generates 6-digit codes (vs. 4-digit Soundex) and can produce multiple codes per name. Better than plain Soundex for Eastern European names, inferior to BMPM for general multi-language use.

### Caverphone

Developed at the University of Otago for matching New Zealand names in historical records. Handles common English/Maori phonetic variations well.

### Cologne Phonetic (Kölner Phonetik)

The German equivalent of Soundex, optimized for German phonology. Use for German-language datasets.

### NYSIIS

New York State Identification and Intelligence System. General-purpose English phonetic algorithm. Less precise than DoubleMetaphone but faster.

---

## 4. Phonetic Analysis in Schema

Phonetic filtering is configured as part of a `fieldType` analyzer in `managed-schema` (or `schema.xml`). The key is to use the same phonetic encoding at both index time and query time so that query tokens and index tokens match.

### PhoneticFilterFactory (Classic Algorithms)

Handles Soundex, Metaphone, DoubleMetaphone, RefinedSoundex, Caverphone, ColognePhonetic, NYSIIS.

```xml
<fieldType name="text_phonetic_soundex" class="solr.TextField" positionIncrementGap="100">
  <analyzer>
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <!-- inject=true keeps original token in stream alongside phonetic code -->
    <!-- inject=false replaces original with phonetic code only -->
    <filter class="solr.PhoneticFilterFactory"
            encoder="DoubleMetaphone"
            inject="true"
            maxCodeLength="8"/>
  </analyzer>
</fieldType>
```

**`inject` parameter is critical:**
- `inject="true"` (default): Both the original token AND its phonetic code are indexed. A standard keyword search still works, plus phonetic fallback occurs automatically.
- `inject="false"`: Only the phonetic code is indexed. Exact spelling queries will not match unless they happen to produce the same code.

In most production scenarios, use `inject="true"` and then apply the same filter at query time, or use separate index/query analyzers (see below).

### BeiderMorseFilterFactory

```xml
<fieldType name="text_phonetic_bmpm" class="solr.TextField" positionIncrementGap="100">
  <analyzer type="index">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.BeiderMorseFilterFactory"
            nameType="GENERIC"
            ruleType="APPROX"
            concat="true"
            languageSet="auto"/>
  </analyzer>
  <analyzer type="query">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.BeiderMorseFilterFactory"
            nameType="GENERIC"
            ruleType="APPROX"
            concat="true"
            languageSet="auto"/>
  </analyzer>
</fieldType>
```

| Parameter | Values | Description |
|---|---|---|
| `nameType` | `GENERIC`, `ASHKENAZI`, `SEPHARDIC` | Type of names being processed. Use `GENERIC` unless you specifically know the names are Ashkenazi Jewish or Sephardic. |
| `ruleType` | `APPROX`, `EXACT` | `APPROX` generates more encodings that cover more phonetic variations. `EXACT` is stricter. |
| `concat` | `true`, `false` | `true` combines multiple encodings with `|` separator into a single token. `false` emits each encoding as a separate token. |
| `languageSet` | `auto` or comma-separated list | `auto` detects language from the token. You can restrict to specific languages: `"English,French,German"`. |

### DaitchMokotoffSoundexFilterFactory

```xml
<fieldType name="text_phonetic_dm" class="solr.TextField" positionIncrementGap="100">
  <analyzer>
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.DaitchMokotoffSoundexFilterFactory" inject="true"/>
  </analyzer>
</fieldType>
```

### Separate Index/Query Analyzers with Phonetics

A common production pattern: index with inject=true for recall, query with inject=false (or a separate phonetic-only field) to avoid exact-match inflation.

```xml
<fieldType name="text_name_phonetic" class="solr.TextField" positionIncrementGap="100">

  <!-- Index: original token + phonetic code, both indexed -->
  <analyzer type="index">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.PhoneticFilterFactory"
            encoder="DoubleMetaphone"
            inject="true"/>
  </analyzer>

  <!-- Query: only emit the phonetic code for matching -->
  <analyzer type="query">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.PhoneticFilterFactory"
            encoder="DoubleMetaphone"
            inject="false"/>
  </analyzer>

</fieldType>
```

With this setup, querying "Smith" produces the phonetic code "SM0", which matches documents where "Smyth", "Smithe", or "Schmidt" were indexed — all of which share the same DoubleMetaphone primary code.

---

## 5. NGram and EdgeNGram for Prefix / Partial Matching

NGrams are sub-sequences of characters. They solve a different problem from fuzzy/phonetic: they enable substring or prefix matching without query-time enumeration.

### EdgeNGram (Prefix Matching / Autocomplete)

EdgeNGram generates tokens from the beginning (edge) of each word. This is the standard approach for type-ahead autocomplete.

```xml
<fieldType name="text_autocomplete" class="solr.TextField" positionIncrementGap="100">

  <!-- Index: generate all prefixes from length 2 to 20 -->
  <analyzer type="index">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.EdgeNGramFilterFactory"
            minGramSize="2"
            maxGramSize="20"
            preserveOriginal="true"/>
  </analyzer>

  <!-- Query: standard tokenization only — match against pre-built prefixes -->
  <analyzer type="query">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
  </analyzer>

</fieldType>
```

For the word "laptop":
- Indexed tokens: `la`, `lap`, `lapt`, `lapto`, `laptop` (plus original if `preserveOriginal="true"`)
- Query for "lap" → exact match against the `lap` token

**Important:** Do NOT apply EdgeNGramFilterFactory to both the index and query analyzers. The index side generates all the prefixes; the query side must emit the raw typed prefix to match against them.

### NGram (Substring / Infix Matching)

NGram generates all sub-sequences of a given length range, enabling matching anywhere within a word (not just from the start).

```xml
<fieldType name="text_ngram" class="solr.TextField" positionIncrementGap="100">

  <analyzer type="index">
    <tokenizer class="solr.WhitespaceTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.NGramFilterFactory"
            minGramSize="3"
            maxGramSize="6"
            preserveOriginal="true"/>
  </analyzer>

  <analyzer type="query">
    <tokenizer class="solr.WhitespaceTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
  </analyzer>

</fieldType>
```

For the word "laptop":
- Indexed tokens: `lap`, `apt`, `pto`, `top`, `lapt`, `apto`, `ptop`, `lapto`, `aptop`, `laptop`
- Query for "pto" → matches because `pto` is in the indexed set

NGram indexes are **large**. A word of length L with gram range [min, max] generates `sum(L - n + 1 for n in range(min, max+1))` tokens. Use sparingly and with a reasonably high `minGramSize` (3 or 4).

### EdgeNGramTokenizerFactory (Alternative)

Instead of a filter, you can use the `EdgeNGramTokenizerFactory` as the tokenizer directly. This treats the entire field value as a single token before generating n-grams — useful for single-value fields like product codes:

```xml
<fieldType name="text_prefix_code" class="solr.TextField">
  <analyzer type="index">
    <!-- Treats the full field as one unit, then grams it -->
    <tokenizer class="solr.EdgeNGramTokenizerFactory"
               minGramSize="1"
               maxGramSize="15"/>
  </analyzer>
  <analyzer type="query">
    <tokenizer class="solr.KeywordTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
  </analyzer>
</fieldType>
```

---

## 6. Synonyms with SynonymGraphFilterFactory

Synonyms expand a query term to equivalent or related terms. In Solr 9, `SynonymGraphFilterFactory` is the preferred implementation over the deprecated `SynonymFilterFactory`.

### synonyms.txt Format

The file supports two formats:

```
# Equivalent synonyms (bidirectional)
couch, sofa, settee

# Explicit mapping (one-directional)
GB => gigabyte
US => United States

# Multi-word synonyms
new york city, nyc, the big apple
```

### Schema Configuration

Synonyms should be applied at **query time only** in most setups. Applying at index time balloons the index and makes synonym updates require a full reindex.

```xml
<fieldType name="text_synonyms" class="solr.TextField" positionIncrementGap="100">

  <!-- Index: standard analysis, no synonyms -->
  <analyzer type="index">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.StopFilterFactory" ignoreCase="true" words="stopwords.txt"/>
    <filter class="solr.PorterStemFilterFactory"/>
  </analyzer>

  <!-- Query: apply synonym expansion before stemming -->
  <analyzer type="query">
    <tokenizer class="solr.StandardTokenizerFactory"/>
    <filter class="solr.LowerCaseFilterFactory"/>
    <filter class="solr.StopFilterFactory" ignoreCase="true" words="stopwords.txt"/>
    <!-- SynonymGraph MUST come before FlattenGraphFilter when used in query analyzer -->
    <filter class="solr.SynonymGraphFilterFactory"
            synonyms="synonyms.txt"
            ignoreCase="true"
            expand="true"/>
    <filter class="solr.FlattenGraphFilterFactory"/>
    <filter class="solr.PorterStemFilterFactory"/>
  </analyzer>

</fieldType>
```

The `FlattenGraphFilterFactory` is **required** after `SynonymGraphFilterFactory` in index-time analyzers (it converts the graph token stream to a flat stream that can be written to the index). For query-time-only synonym usage, it is not strictly required but is harmless.

### expand vs. Explicit Mapping

- `expand="true"`: A query for `couch` expands to `couch OR sofa OR settee`
- `expand="false"` with `GB => gigabyte`: A query for `GB` becomes `gigabyte` only

### Dynamic Synonym Reloading (Solr 9)

Solr 9 supports managed resources, allowing synonym files to be updated via the REST API without a core reload:

```bash
# Add a synonym via the managed synonyms API
curl -X PUT http://localhost:8983/solr/mycollection/schema/analysis/synonyms/english \
  -H 'Content-type:application/json' \
  -d '{"TV": ["television", "telly"]}'
```

Requires configuring `SynonymGraphFilterFactory` with `managed="true"` and the appropriate managed schema setup.

---

## 7. SpellCheck Component

The SpellCheck component provides "did you mean?" suggestions for misspelled queries. It is a search component registered in `solrconfig.xml` and attached to a request handler.

### DirectSolrSpellChecker (Recommended for Solr 9)

Queries the main Solr index directly — no secondary spell-check index required. Always in sync with the main index.

```xml
<!-- In solrconfig.xml -->
<searchComponent name="spellcheck" class="solr.SpellCheckComponent">

  <lst name="spellchecker">
    <str name="name">default</str>
    <str name="classname">solr.DirectSolrSpellChecker</str>
    <!-- Field to use for spell suggestions -->
    <str name="field">text</str>
    <!-- Damerau-Levenshtein is the default; "internal" = same -->
    <str name="distanceMeasure">internal</str>
    <!-- Accuracy threshold: 0.0–1.0; higher = more conservative suggestions -->
    <float name="accuracy">0.5</float>
    <!-- Max edits allowed for a suggestion (1 or 2) -->
    <int name="maxEdits">2</int>
    <!-- Minimum characters at start that must match -->
    <int name="minPrefix">1</int>
    <!-- Max candidates inspected per term -->
    <int name="maxInspections">5</int>
    <!-- Ignore query terms shorter than this -->
    <int name="minQueryLength">4</int>
    <!-- Ignore query terms longer than this -->
    <int name="maxQueryLength">40</int>
    <!-- Terms that appear in > this fraction of docs are not suggestions -->
    <!-- (they are already "correct" words) -->
    <float name="maxQueryFrequency">0.01</float>
    <!-- Min fraction of docs a suggestion must appear in -->
    <float name="thresholdTokenFrequency">0.0</float>
  </lst>

</searchComponent>
```

### IndexBasedSpellChecker (Legacy, Still Valid)

Builds a separate parallel Lucene index for spell checking. Must be explicitly rebuilt after index changes.

```xml
<searchComponent name="spellcheck" class="solr.SpellCheckComponent">

  <lst name="spellchecker">
    <str name="name">default</str>
    <str name="classname">solr.IndexBasedSpellChecker</str>
    <str name="spellcheckIndexDir">./spellchecker</str>
    <!-- Copy terms from this field -->
    <str name="field">content</str>
    <!-- Frequency-based sorting of suggestions -->
    <str name="comparatorClass">freq</str>
    <float name="accuracy">0.5</float>
    <!-- Rebuild spell index on every commit (expensive!) -->
    <str name="buildOnCommit">false</str>
    <str name="buildOnOptimize">true</str>
  </lst>

</searchComponent>
```

### Attaching SpellCheck to a Request Handler

```xml
<requestHandler name="/select" class="solr.SearchHandler">
  <lst name="defaults">
    <str name="df">text</str>
    <str name="spellcheck.dictionary">default</str>
    <str name="spellcheck">on</str>
    <str name="spellcheck.extendedResults">false</str>
    <str name="spellcheck.count">5</str>
    <!-- Collate: return a corrected full query string -->
    <str name="spellcheck.collate">true</str>
    <str name="spellcheck.maxCollations">3</str>
    <str name="spellcheck.maxCollationTries">10</str>
    <!-- Only suggest when the original query has few results -->
    <str name="spellcheck.onlyMorePopular">true</str>
  </lst>
  <arr name="last-components">
    <str>spellcheck</str>
  </arr>
</requestHandler>
```

### Key Query-Time Parameters

| Parameter | Description |
|---|---|
| `spellcheck=true` | Enable spell checking for this request |
| `spellcheck.q` | Override the query sent to spell checker (useful when `q` contains structured syntax) |
| `spellcheck.count=5` | Max suggestions per term |
| `spellcheck.collate=true` | Return a corrected full query string |
| `spellcheck.collateParam.mm=100%` | When testing collations, require all terms to match |
| `spellcheck.build=true` | Rebuild the spell checker index (IndexBased only) |
| `spellcheck.reload=true` | Reload the spell checker dictionary |

### Example Response

```json
{
  "spellcheck": {
    "suggestions": [
      "solor",
      {
        "numFound": 2,
        "startOffset": 0,
        "endOffset": 5,
        "origFreq": 0,
        "suggestion": [
          { "word": "solar", "freq": 124 },
          { "word": "color", "freq": 89 }
        ]
      }
    ],
    "correctlySpelled": false,
    "collations": [
      "collation",
      { "collationQuery": "solar search", "hits": 47 }
    ]
  }
}
```

---

## 8. Query Parsers: eDisMax vs. DisMax

### DisMax (`defType=dismax`)

The original multi-field query parser. Provides:
- `qf` (query fields with boost weights)
- `mm` (minimum match)
- `pf` (phrase fields for proximity boost)
- `bf` (boost functions)

DisMax does **not** support the full Lucene query syntax by default, which limits its use with fuzzy operators. It does however allow field-boosted fuzzy if you pass the tilde through:

```
defType=dismax&qf=title^10 body^1&q=roaming~1
```

### Extended DisMax (`defType=edismax`)

The recommended parser for all production fuzzy/phonetic search scenarios. It is a strict superset of DisMax that additionally supports:

- Standard query parser syntax (field:value, -, +, wildcards, fuzzy `~`)
- Per-field fuzzy via the `qf` parameter
- `boost` parameter (function multiplier, cleaner than `bf`)
- `pf2`/`pf3` for bigram/trigram phrase boosting
- `mm.autoRelax` for graceful stopword handling

```
defType=edismax
&qf=title^10 description^3 tags^5 text^1
&pf=title^20 description^5
&mm=75%
&q=roaming camera~1 review
```

### eDisMax: Fuzzy-Relevant Parameters

| Parameter | Example | Description |
|---|---|---|
| `qf` | `title^10 body^1` | Fields to search with boost multipliers |
| `pf` | `title^20` | Phrase proximity boost fields |
| `pf2` | `title^15` | Bigram phrase boost |
| `pf3` | `title^10` | Trigram phrase boost |
| `ps` | `2` | Phrase slop for `pf` |
| `mm` | `2<75%` | Minimum match: for queries >2 terms, 75% must match |
| `mm.autoRelax` | `true` | Relax mm when stopword removal creates imbalance |
| `boost` | `recip(ms(NOW,last_modified),3.16e-11,1,1)` | Multiplicative document boost function |
| `bf` | `popularity^0.5` | Additive boost function |
| `sow` | `false` | Split on whitespace; `false` allows multi-word synonym expansion |

### eDisMax vs. Standard Parser for Fuzzy

The standard query parser (`defType=lucene`) supports fuzzy syntax but lacks multi-field boosting. For any production search box, use eDisMax. The fuzzy `~` operator works identically in both:

```
# Standard parser — fuzzy, single field
q=title:roam~1

# eDisMax — fuzzy across multiple boosted fields
defType=edismax&qf=title^10 body^1&q=roam~1
```

For very specific phonetic field targeting, you can still use the standard parser with explicit field references alongside a phonetic field:

```
q=name:smith OR name_phonetic:smith
```

---

## 9. Boosting and Scoring for Fuzzy Matches

Fuzzy matches score lower than exact matches by default because Lucene's TF-IDF / BM25 scoring penalizes low-frequency matches. Here are the standard approaches to controlling relevance with fuzzy/phonetic results.

### Understanding Fuzzy Scoring

A fuzzy match at edit distance 1 receives a boost of `1.0 - (1/maxEdits)` relative to an exact match. At edit distance 2, this drops further. The exact calculation:

```
score(fuzzy_match) = score(exact_match) * (1.0 - edit_distance / max_edits)
```

So `roam~2` matching `foam` (edit distance 1) scores higher than `roam~2` matching `foams` (edit distance 2).

### Field Boosting with qf

Separate your phonetic field from your main field and boost appropriately:

```
defType=edismax
&qf=title^10 title_phonetic^3 description^2 description_phonetic^0.5
&q=smyth
```

This means an exact title match outweighs a phonetic title match, which outweighs an exact description match.

### Phrase Boosting (pf, pf2, pf3)

Reward documents where all query terms appear close together:

```
defType=edismax
&qf=title^5 body^1
&pf=title^20 body^5
&pf2=title^10
&ps=2
&q=wireless bluetooth speaker
```

If "wireless bluetooth speaker" appears as a phrase in the title (not just three separate terms), the `pf` boost applies multiplicatively.

### Function Queries for Document-Level Boost

Use the `boost` parameter with Solr function query syntax:

```
# Boost by recency — more recent documents score higher
&boost=recip(ms(NOW,created_date),3.16e-11,1,1)

# Boost by a numeric field (e.g., sales rank, popularity)
&boost=log(sum(1,popularity_score))

# Combine: recent AND popular
&boost=product(recip(ms(NOW,created_date),3.16e-11,1,1),log(sum(1,popularity_score)))
```

### Boosting Exact Over Fuzzy Results

A common pattern: run the same query twice in a single request using `bq` (boost query) to reward exact matches over fuzzy ones:

```
defType=edismax
&qf=title^5 body^1
&q=roaming~1
&bq=title:"roaming"^20
```

Documents where `roaming` appears exactly get the `bq` bonus on top of the fuzzy match score.

### Using copyField for Multi-Strategy Scoring

Solr's `copyField` directive copies content to multiple fields with different analyzers, allowing the same document to be scored against multiple strategies simultaneously:

```xml
<!-- In schema -->
<field name="name" type="text_general" indexed="true" stored="true"/>
<field name="name_phonetic" type="text_phonetic_bmpm" indexed="true" stored="false"/>
<field name="name_ngram" type="text_autocomplete" indexed="true" stored="false"/>

<copyField source="name" dest="name_phonetic"/>
<copyField source="name" dest="name_ngram"/>
```

Then query all three with appropriate boosts:
```
defType=edismax&qf=name^10 name_phonetic^3 name_ngram^2&q=smyth
```

---

## 10. Practical Example: Full "Fuzzy Search" Field Type

This is a production-grade schema configuration combining standard text analysis, phonetic encoding, EdgeNGram prefix matching, and synonym expansion into a coherent multi-strategy search field.

### managed-schema (schema.xml) Configuration

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<schema name="fuzzy-search-example" version="1.6">

  <!-- ================================================================
       FIELD TYPES
       ================================================================ -->

  <!-- 1. Standard text: good baseline, stemming + stopwords -->
  <fieldType name="text_general" class="solr.TextField"
             positionIncrementGap="100">
    <analyzer type="index">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.StopFilterFactory"
              ignoreCase="true" words="stopwords.txt"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.PorterStemFilterFactory"/>
    </analyzer>
    <analyzer type="query">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.StopFilterFactory"
              ignoreCase="true" words="stopwords.txt"/>
      <filter class="solr.SynonymGraphFilterFactory"
              synonyms="synonyms.txt"
              ignoreCase="true"
              expand="true"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.PorterStemFilterFactory"/>
    </analyzer>
  </fieldType>

  <!-- 2. Phonetic field: DoubleMetaphone for sound-alike matching -->
  <fieldType name="text_phonetic" class="solr.TextField"
             positionIncrementGap="100">
    <analyzer type="index">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <!-- inject=true: keep original token + add phonetic code -->
      <filter class="solr.PhoneticFilterFactory"
              encoder="DoubleMetaphone"
              inject="true"
              maxCodeLength="8"/>
    </analyzer>
    <analyzer type="query">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <!-- query with inject=false: only emit phonetic code to match index -->
      <filter class="solr.PhoneticFilterFactory"
              encoder="DoubleMetaphone"
              inject="false"
              maxCodeLength="8"/>
    </analyzer>
  </fieldType>

  <!-- 3. Beider-Morse for personal name matching (multi-language) -->
  <fieldType name="text_phonetic_name" class="solr.TextField"
             positionIncrementGap="100">
    <analyzer type="index">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.BeiderMorseFilterFactory"
              nameType="GENERIC"
              ruleType="APPROX"
              concat="true"
              languageSet="auto"/>
    </analyzer>
    <analyzer type="query">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.BeiderMorseFilterFactory"
              nameType="GENERIC"
              ruleType="APPROX"
              concat="true"
              languageSet="auto"/>
    </analyzer>
  </fieldType>

  <!-- 4. EdgeNGram for prefix/autocomplete matching -->
  <fieldType name="text_autocomplete" class="solr.TextField"
             positionIncrementGap="100">
    <analyzer type="index">
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.EdgeNGramFilterFactory"
              minGramSize="2"
              maxGramSize="20"
              preserveOriginal="true"/>
    </analyzer>
    <analyzer type="query">
      <!-- Query-side: no EdgeNGram — match the raw typed prefix -->
      <tokenizer class="solr.StandardTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
    </analyzer>
  </fieldType>

  <!-- 5. NGram for substring/infix matching (use sparingly — large index) -->
  <fieldType name="text_ngram_infix" class="solr.TextField"
             positionIncrementGap="100">
    <analyzer type="index">
      <tokenizer class="solr.WhitespaceTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
      <filter class="solr.NGramFilterFactory"
              minGramSize="3"
              maxGramSize="6"
              preserveOriginal="true"/>
    </analyzer>
    <analyzer type="query">
      <tokenizer class="solr.WhitespaceTokenizerFactory"/>
      <filter class="solr.LowerCaseFilterFactory"/>
    </analyzer>
  </fieldType>


  <!-- ================================================================
       FIELDS
       ================================================================ -->

  <field name="id"          type="string"           indexed="true"  stored="true" required="true"/>
  <field name="title"       type="text_general"     indexed="true"  stored="true"/>
  <field name="description" type="text_general"     indexed="true"  stored="true"/>
  <field name="author_name" type="text_general"     indexed="true"  stored="true"/>

  <!-- Copy targets for alternative analyzers (stored=false saves disk) -->
  <field name="title_phonetic"    type="text_phonetic"    indexed="true" stored="false"/>
  <field name="title_autocomplete" type="text_autocomplete" indexed="true" stored="false"/>
  <field name="author_phonetic"   type="text_phonetic_name" indexed="true" stored="false"/>

  <!-- Catch-all search field -->
  <field name="_text_" type="text_general" indexed="true" stored="false" multiValued="true"/>

  <!-- Copy fields: same data, different analysis strategies -->
  <copyField source="title"       dest="title_phonetic"/>
  <copyField source="title"       dest="title_autocomplete"/>
  <copyField source="author_name" dest="author_phonetic"/>
  <copyField source="title"       dest="_text_"/>
  <copyField source="description" dest="_text_"/>
  <copyField source="author_name" dest="_text_"/>

  <uniqueKey>id</uniqueKey>

</schema>
```

### Example Queries Against This Schema

```bash
# 1. Exact + stemmed match via text_general
curl "http://localhost:8983/solr/mycollection/select?\
defType=edismax\
&qf=title^10+description^3+author_name^5\
&pf=title^20\
&q=wireless+speakers"

# 2. Fuzzy typo tolerance at query time (edit distance 1)
curl "http://localhost:8983/solr/mycollection/select?\
defType=edismax\
&qf=title^10+description^3\
&q=wireles~1+spekers~1"

# 3. Phonetic name search: "smyth" finds "Smith", "Smithe", "Smid"
curl "http://localhost:8983/solr/mycollection/select?\
defType=edismax\
&qf=author_name^5+author_phonetic^3\
&q=smyth"

# 4. Autocomplete prefix: "wire" finds "wireless", "wired", "wires"
curl "http://localhost:8983/solr/mycollection/select?\
defType=edismax\
&qf=title_autocomplete^5+title^3\
&q=wire"

# 5. Combined strategy: exact title boost + phonetic fallback + fuzzy
curl "http://localhost:8983/solr/mycollection/select?\
defType=edismax\
&qf=title^10+title_phonetic^4+title_autocomplete^2+description^1\
&pf=title^25\
&mm=1\
&boost=recip(ms(NOW,published_date),3.16e-11,1,1)\
&q=smyth+wireles~1+spekers~1"

# 6. Fuzzy query parser with prefixLength for precision + performance
curl "http://localhost:8983/solr/mycollection/select?\
q={!fuzzy+f=title+maxEdits=1+prefixLength=3+maxExpansions=30}wireless"
```

---

## 11. Performance Implications

### Query-Time Fuzzy (Tilde Operator)

**Index size impact:** None. Fuzzy queries enumerate the existing index at query time.

**Query time impact:** Potentially significant. The FuzzyQuery enumerates all terms in the index within edit distance N of the query term. For large indexes with many unique terms, this enumeration can be expensive.

Mitigation strategies:
- Set `prefixLength >= 2` whenever the domain allows it (e.g., for `{!fuzzy}` parser)
- Set `maxExpansions` to a reasonable limit (50 is the default; 20-30 is often sufficient)
- Keep edit distance at 1 instead of 2 when possible — edit distance 1 produces far fewer candidate terms
- Avoid fuzzy on very short terms (< 4 characters) — the candidate space explodes

**Note:** Since Lucene 4.0, the FuzzyQuery uses a Levenshtein automaton approach that is approximately 100x faster than the original brute-force approach. The performance is now primarily bounded by `maxExpansions`, not raw edit distance.

### Phonetic Analysis (Index Time)

**Index size impact:** With `inject="true"`, phonetic fields roughly double the number of tokens per field. With `inject="false"`, token count stays the same but token content changes.

DoubleMetaphone with `inject=true` adds approximately 50-100% storage overhead per field. BeiderMorse with `concat=true` is similar. BeiderMorse with `concat=false` (separate tokens) can generate 5-10 tokens per input token.

**Query time impact:** Phonetic fields at query time are just exact-match lookups against phonetic codes — very fast. The only overhead is the analysis chain applied to the query string.

**Recommendation:** Always use `inject="true"` for phonetic fields and keep phonetic fields as non-stored (`stored="false"`) — they need not be retrieved, only searched.

### NGram / EdgeNGram

**Index size impact:** This is where things get expensive.

For a field with average token length L and EdgeNGram range [2, 20]:
- Each token generates up to 19 prefix tokens
- A 100-document index with 100 tokens per document generates 1,900 EdgeNGram tokens vs. 100 standard tokens

NGramFilter (infix) is even more expensive:
- A 10-character word with gram range [3, 6] generates 4+3+2+1 = 10 tokens
- Across 10,000 unique terms, the index grows by roughly 10x

**Practical limits:**
- EdgeNGram: `maxGramSize` of 15-20 is usually sufficient for autocomplete. Do not set it to the full field length.
- NGram: `minGramSize` of 3+ and `maxGramSize` of 5-6 are reasonable. Do not go below minGram=2 for large fields.
- Apply NGram/EdgeNGram only to targeted fields, not to `_text_` catch-all fields.

**Query time impact:** Negligible — NGram queries are exact lookups.

### SpellCheck

**Index size (IndexBasedSpellChecker):** Maintains a secondary Lucene index, typically 20-50% of the main index size. Must be rebuilt manually or on commit/optimize.

**Index size (DirectSolrSpellChecker):** No additional storage — queries the main index directly.

**Query time:** DirectSolrSpellChecker adds 5-50ms per query depending on the index size and `maxInspections`. The spellcheck runs after the main query, so it does not block result delivery.

### Summary Table

| Strategy | Index Overhead | Query Overhead | Flexibility |
|---|---|---|---|
| Query-time fuzzy (`~`) | None | Medium (bounded by `maxExpansions`) | High (any edit distance, any field) |
| Phonetic field (inject=true) | ~50-100% per field | Minimal (exact lookup) | Low (fixed algorithm) |
| BeiderMorse (concat=false) | High (5-10x tokens) | Minimal | Medium |
| EdgeNGram | High (up to 19x tokens) | Minimal | Low (prefix only) |
| NGram (infix) | Very high (10-50x) | Minimal | Low (fixed gram sizes) |
| DirectSpellChecker | None | Low-medium (5-50ms) | High |
| IndexBasedSpellChecker | ~20-50% | Low | High |

---

## 12. Testing and Debugging

### The Analysis UI

Solr's built-in Analysis page is the fastest way to inspect what a field type does to text:

```
http://localhost:8983/solr/#/mycollection/analysis
```

Enter an index value and a query value, select your field type, and Solr shows the token stream at every analysis step. This is indispensable for verifying phonetic encoding, synonym expansion, and NGram generation.

### The Analysis API (Programmatic)

```bash
# Check how "Smyth" is analyzed by the text_phonetic_name field type
curl "http://localhost:8983/solr/mycollection/analysis/field?\
analysis.fieldType=text_phonetic_name\
&analysis.fieldvalue=Smyth\
&wt=json" | python3 -m json.tool
```

The response includes `org.apache.lucene.analysis.phonetic.BeiderMorseFilter` output showing every generated phonetic code.

### Debug Query

Add `debugQuery=true` to any query to get full scoring explanation and parsed query details:

```bash
curl "http://localhost:8983/solr/mycollection/select?\
defType=edismax\
&qf=title^10+title_phonetic^3\
&q=smyth\
&debugQuery=true\
&wt=json"
```

The `debug.explain` section shows per-document scoring breakdown:
```json
{
  "debug": {
    "parsedquery": "+((title:smyth)^10.0 (title_phonetic:SM0)^3.0)",
    "explain": {
      "doc1": "8.32 = sum of:\n  7.65 = weight(title:smyth...)\n  0.67 = weight(title_phonetic:SM0...)"
    }
  }
}
```

This reveals exactly which terms matched and how scoring was computed — essential for diagnosing why a phonetic match ranked unexpectedly.

### Luke Request Handler

The Luke handler exposes index-level statistics and term information:

```bash
# List all unique terms in the title_phonetic field
curl "http://localhost:8983/solr/mycollection/admin/luke?\
fl=title_phonetic\
&numTerms=50\
&wt=json"

# Inspect a specific document's stored and indexed fields
curl "http://localhost:8983/solr/mycollection/admin/luke?\
id=doc123\
&wt=json"
```

### Testing Phonetic Accuracy

Build a small test document set with known variants and verify recall:

```bash
# Index test documents with known names
curl -X POST "http://localhost:8983/solr/mycollection/update?commit=true" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "1", "author_name": "Smith, John"},
    {"id": "2", "author_name": "Smyth, John"},
    {"id": "3", "author_name": "Smithe, Jonathan"},
    {"id": "4", "author_name": "Schmidt, Johann"}
  ]'

# Query: all four should be returned (DoubleMetaphone: SM0 / XMT)
curl "http://localhost:8983/solr/mycollection/select?\
defType=edismax\
&qf=author_phonetic\
&q=Smith\
&fl=id,author_name\
&wt=json"
```

### Monitoring SpellCheck Quality

Compare spellcheck suggestions against known misspellings in query logs. Key metrics to track:
- **Suggestion acceptance rate**: How often users click a spellcheck suggestion
- **Zero-result queries before/after**: Did spellcheck reduce zero-result searches?
- **False positives**: Suggestions offered for correctly spelled rare terms

```bash
# Force spell check even if the query returns results
curl "http://localhost:8983/solr/mycollection/select?\
q=wireles+speekers\
&spellcheck=true\
&spellcheck.count=3\
&spellcheck.collate=true\
&spellcheck.onlyMorePopular=false\
&wt=json"
```

### Verifying NGram Tokens

```bash
# What prefix tokens does "wireless" generate in the autocomplete field?
curl "http://localhost:8983/solr/mycollection/analysis/field?\
analysis.fieldType=text_autocomplete\
&analysis.fieldvalue=wireless\
&wt=json"
```

Expected output: tokens `wi`, `wir`, `wire`, `wirel`, `wirele`, `wireles`, `wireless` — each a valid prefix match target.

---

## Reference Links

- [Solr Standard Query Parser Reference](https://solr.apache.org/guide/solr/latest/query-guide/standard-query-parser.html)
- [Extended DisMax Query Parser Reference](https://solr.apache.org/guide/solr/latest/query-guide/edismax-query-parser.html)
- [Phonetic Matching Reference](https://solr.apache.org/guide/solr/latest/indexing-guide/phonetic-matching.html)
- [Filter Descriptions Reference](https://solr.apache.org/guide/solr/latest/indexing-guide/filters.html)
- [Tokenizers Reference](https://solr.apache.org/guide/solr/latest/indexing-guide/tokenizers.html)
- [Spell Checking Reference](https://solr.apache.org/guide/solr/latest/query-guide/spell-checking.html)
- [Other Query Parsers (Fuzzy QParser)](https://solr.apache.org/guide/solr/latest/query-guide/other-parsers.html)
- [Schema Elements Reference](https://solr.apache.org/guide/solr/latest/indexing-guide/schema-elements.html)
- [Beider-Morse in Solr (The Digital Group Blog)](https://blog.thedigitalgroup.com/beider-morse-phonetic-matching-in-solr)
- [Lucene FuzzyQuery Performance (McCandless)](https://blog.mikemccandless.com/2011/03/lucenes-fuzzyquery-is-100-times-faster.html)
