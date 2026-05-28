# Search Engine Comparison: Solr, Elasticsearch, OpenSearch, Meilisearch, Typesense

**Last updated:** March 2026 (research current as of early 2026)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Comparison Matrix](#2-comparison-matrix)
3. [Licensing Deep-Dive](#3-licensing-deep-dive)
4. [Docker Quick-Start](#4-docker-quick-start)
5. [Node.js Client Status](#5-nodejs-client-status)
6. [Feature Matrix](#6-feature-matrix)
7. [Performance Characteristics](#7-performance-characteristics)
8. [Operational Complexity](#8-operational-complexity)
9. [Verdict](#9-verdict)

---

## 1. Executive Summary

### Apache Solr

Solr is the battle-hardened workhorse. It's genuinely Apache 2.0 licensed with no strings attached, has been around since 2006, and handles enormous datasets in enterprise environments. The catch: it's showing its age. The XML configuration model, ZooKeeper dependency for clustering (SolrCloud), and steep learning curve make it a friction-heavy choice for teams who just want search to work. Its Node.js client ecosystem is effectively abandoned. If you're greenfielding a project, there's almost no reason to pick Solr over OpenSearch or a modern alternative. It earns its place in existing enterprise deployments and situations requiring deep Lucene feature access.

**Recommended for:** Enterprises already running Solr, teams with Lucene/Solr expertise, complex enterprise search with existing Solr tooling.

### Elasticsearch

The original king of search. Powerful, mature, distributed-first, excellent tooling, and the best Node.js client in the category. But the licensing history is a cautionary tale: Elastic switched from Apache 2.0 to SSPL/Elastic License in 2021, then added AGPL in late 2024. The critical nuance: the binary distributions you actually download and run are under **Elastic License 2.0**, not AGPL. ELv2 prohibits providing Elasticsearch as a hosted/managed service to third parties. For self-hosted internal use, ELv2 is permissive — but it's not OSI-approved open source. It's "source-available commercial." If licensing purity matters to your organization, this is a hard stop.

**Recommended for:** Teams where licensing purity is NOT a constraint, who need massive scale, advanced aggregations, log analytics, or Kibana integration.

### OpenSearch

The rightful heir to pre-2021 Elasticsearch. Genuinely Apache 2.0, governed by the Linux Foundation's OpenSearch Software Foundation (not just AWS anymore), and nearly API-compatible with Elasticsearch 7.10. OpenSearch 3.0 released in April 2025, upgrading to Apache Lucene 10 and adding significant new features. The community is healthy: 400+ contributing organizations, 1 billion+ downloads, 78% YoY download growth. The Node.js client (v3.0+) has proper TypeScript support generated from the OpenSearch API spec. This is the clear choice when "truly free and open source" is a hard requirement and you need Elasticsearch-class power.

**Recommended for:** Anyone who needs Elasticsearch-level power with zero licensing anxiety. The default choice for new distributed search infrastructure.

### Meilisearch

The fastest-to-implement search engine in this list. The REST API is genuinely delightful, indexing is shockingly fast (up to 7x faster than Elasticsearch in some benchmarks), and it's designed for developer productivity above all else. The licensing is mostly MIT — the core search engine is MIT, and enterprise-only features (sharding, S3 snapshots, IRSA auth) are under BUSL 1.1. For the vast majority of self-hosted single-node use cases, this is a non-issue. The tradeoff: no native horizontal sharding without the enterprise license, which means it tops out at single-node scale. For apps with datasets up to tens of millions of documents, this is irrelevant. Above that, plan accordingly.

**Recommended for:** Product search, documentation search, SaaS apps, any use case where developer experience and time-to-working-search matters more than billion-document scale.

### Typesense

The closest thing to "Algolia but self-hosted and open source" (it literally markets itself that way). GPL-3.0 licensed, written in C++, truly in-memory-first, and delivers sub-50ms search latency as a baseline. The Node.js/TypeScript client is polished. The key limitation is that it replicates data across nodes rather than sharding, so horizontal scale adds redundancy but not capacity. You can't exceed single-node dataset size in a cluster. Also: GPL-3.0 is a valid open source license but has copyleft implications that some commercial legal teams find uncomfortable, even for self-hosted tools. If you're not distributing Typesense-linked code, this is usually a non-issue.

**Recommended for:** Search experiences where latency is paramount, Algolia drop-in replacement, teams that want the absolute simplest self-hosted setup.

---

## 2. Comparison Matrix

| Dimension | Apache Solr | Elasticsearch | OpenSearch | Meilisearch | Typesense |
|-----------|-------------|---------------|------------|-------------|-----------|
| **License** | Apache 2.0 | Elastic License 2.0 (binary) / AGPL (source) | Apache 2.0 | MIT (core) / BUSL 1.1 (EE) | GPL-3.0 |
| **OSI-approved** | Yes | No (ELv2) | Yes | Yes (MIT core) | Yes (GPL-3) |
| **Truly free forever** | Yes | Self-hosted internal use: yes; managed service: no | Yes | Core features: yes | Yes |
| **Docker official image** | Yes (hub.docker.com/_/solr) | Yes (hub.docker.com/_/elasticsearch) | Yes (opensearchproject/opensearch) | Yes (getmeili/meilisearch) | Yes (typesense/typesense) |
| **Node.js client quality** | Poor (abandoned community lib) | Excellent (official @elastic/elasticsearch) | Good (official @opensearch-project/opensearch) | Excellent (official meilisearch-js) | Excellent (official typesense-js) |
| **TypeScript support** | Partial (community @types) | Full (built-in since v8) | Full (v3.0+, spec-generated) | Full (built-in) | Full (built-in) |
| **ESM support** | Absent | Yes | Yes | Yes | Yes |
| **Min RAM (single node)** | ~512MB JVM heap (2GB+ recommended) | ~1GB JVM heap (4GB+ recommended) | ~512MB JVM heap (4GB+ recommended) | ~512MB+ (scales with data) | ~30MB + 2-3x dataset size |
| **Horizontal sharding** | Yes (SolrCloud + ZooKeeper) | Yes (native) | Yes (native) | Enterprise license only | No (replication only) |
| **Setup complexity** | High (XML config, ZooKeeper) | Medium (REST config, cluster mgmt) | Medium (REST config, cluster mgmt) | Very low | Very low |
| **Performance (latency)** | Good | Very good | Very good | Excellent (small-med data) | Excellent |
| **Performance (indexing)** | Good | Good | Good | Outstanding (7x faster) | Good |
| **Best dataset scale** | Billions of docs | Billions of docs | Billions of docs | Tens of millions (self-hosted free) | Tens of millions |
| **Full-text search** | Yes | Yes | Yes | Yes | Yes |
| **Fuzzy/typo tolerance** | Yes (configurable) | Yes | Yes | Yes (automatic) | Yes (automatic) |
| **Faceting** | Yes | Yes | Yes | Yes | Yes |
| **Geosearch** | Yes | Yes | Yes | Yes | Yes |
| **Synonyms** | Yes | Yes | Yes | Yes | Yes |
| **Phonetic search** | Yes (Metaphone, Double Metaphone, Soundex) | Yes (phonetic plugin) | Yes (phonetic plugin) | No | No |
| **Vector/semantic search** | Yes (kNN, Solr 9+) | Yes (mature) | Yes | Yes (hybrid) | Yes (hybrid) |
| **Highlighting** | Yes | Yes | Yes | Yes | Yes |
| **Analytics aggregations** | Yes | Yes (best in class) | Yes | Limited | Limited |
| **Community size** | Large (mature/declining) | Very large | Large (growing fast) | Medium (growing) | Medium (growing) |
| **GitHub stars (approx)** | ~10k | ~70k | ~10k | ~48k | ~21k |
| **Primary language** | Java | Java | Java | Rust | C++ |
| **API style** | REST + XML legacy | REST JSON | REST JSON | REST JSON | REST JSON |

---

## 3. Licensing Deep-Dive

### The Landscape You Need to Understand

There are four license categories at play here:

1. **True permissive open source** (Apache 2.0, MIT) — Do whatever you want. OSI-approved. No restrictions on use, modification, distribution, or SaaS.
2. **True copyleft open source** (GPL-3.0, AGPL-3.0) — OSI-approved, but if you distribute software incorporating it (or, in AGPL's case, expose it over a network), you must also release your modifications under the same license.
3. **Business Source License (BUSL 1.1)** — Source is available, but production use of certain features requires a commercial agreement. Converts to a permissive license (often MIT) after 4 years.
4. **Source-available commercial** (SSPL, Elastic License 2.0) — Source is visible but it's not open source. SSPL is not OSI-approved. ELv2 explicitly restricts managed service use.

### Apache Solr — Apache 2.0

**Clean.** No asterisks. The Apache Software Foundation has managed this project since 2006. You can use it, embed it, build a managed cloud service on it, and never pay anyone anything. This is the gold standard of licensing certainty.

### Elasticsearch — The Complicated One

The history matters because the trust deficit is real:

- **Pre-2021:** Apache 2.0. Truly open source.
- **January 2021:** Switched to SSPL 1.0 and Elastic License 2.0. Community trust shattered. AWS forked it.
- **August 2024:** Elastic added AGPL-3.0 as a third license option for the *source code*.

Here's the nuance that most headlines got wrong: **the binary distributions Elastic ships are still under Elastic License 2.0.** ELv2 is a reasonable license for self-hosted internal use — it's permissive for that case — but it explicitly prohibits "providing the functionalities of the Software to third parties as a hosted or managed service." If you're running Elasticsearch internally, ELv2 is fine. If you want to offer it as a service to customers, it's not.

The AGPL addition means the *source code* is now properly open source and you could theoretically build a GPL-compatible distribution yourself. But in practice, the pre-built Elastic Stack you download from elastic.co is ELv2, not AGPL. **ELv2 is NOT OSI-approved open source.**

**Verdict:** If "open source" is a contractual or philosophical requirement, Elasticsearch fails the test as distributed. If you're self-hosting internally and just want a capable search engine, ELv2 is effectively permissive enough.

### OpenSearch — Apache 2.0

**Clean.** AWS forked Elasticsearch 7.10.2 (the last Apache 2.0 version) in 2021 and donated it to the Linux Foundation in 2024 as the OpenSearch Software Foundation. The project is Apache 2.0 throughout — engine, dashboards, clients, plugins. No single vendor controls the roadmap. This is the most trustworthy of the Elasticsearch-lineage options from a licensing standpoint.

### Meilisearch — MIT (core) / BUSL 1.1 (Enterprise Edition)

**Mostly clean.** The core Meilisearch engine — full-text search, vector/hybrid search, all the features most users need — is MIT licensed. No restrictions whatsoever. The Enterprise Edition features are BUSL 1.1, which means:

- You can use EE features in development, testing, and evaluation for free.
- Production use of EE features requires a commercial license from Meilisearch SAS.
- BUSL converts to MIT after 4 years.

**What's in the EE tier?** Primarily: horizontal sharding (distributing data across multiple nodes), S3-streaming snapshots, and IRSA authentication for AWS. If you're running a single node (which covers most use cases up to tens of millions of documents), you never touch EE features. The MIT core is fully functional.

**Verdict:** For most teams, Meilisearch is effectively MIT-licensed free software. The BUSL gate only applies when you've scaled past single-node capacity.

### Typesense — GPL-3.0

**Genuinely open source, but copyleft.** GPL-3.0 is an OSI-approved license that requires derivative works to also be GPL-3.0. The key question is whether your use of Typesense creates a "derivative work":

- **Running Typesense as a server and calling its API:** Not a derivative work. Your application code remains yours. This is the normal use case.
- **Modifying Typesense's C++ source and distributing the binary:** You must release your modifications under GPL-3.0.
- **Statically linking Typesense into your application:** Potentially a derivative work under strict GPL interpretation.

For the vast majority of teams who run Typesense as a separate service and talk to it over HTTP, GPL-3.0 has zero practical impact on your codebase. Some corporate legal teams reflexively reject any GPL regardless of usage; if yours does, be aware.

---

## 4. Docker Quick-Start

### Apache Solr

```yaml
services:
  solr:
    image: solr:9
    ports:
      - "8983:8983"
    volumes:
      - solr_data:/var/solr
    command:
      - solr-precreate
      - mycore

volumes:
  solr_data:
```

Access at `http://localhost:8983/solr`. Note: this is standalone mode. SolrCloud (for production clustering) additionally requires ZooKeeper:

```yaml
services:
  zookeeper:
    image: zookeeper:3.9
    environment:
      ZOO_MY_ID: 1
    volumes:
      - zk_data:/data

  solr:
    image: solr:9
    ports:
      - "8983:8983"
    environment:
      ZK_HOST: zookeeper:2181
    depends_on:
      - zookeeper
    volumes:
      - solr_data:/var/solr

volumes:
  solr_data:
  zk_data:
```

### Elasticsearch

```yaml
services:
  elasticsearch:
    image: elasticsearch:8.17.0
    environment:
      - discovery.type=single-node
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
      - xpack.security.enabled=false   # dev only — enable in production
    ports:
      - "9200:9200"
    volumes:
      - es_data:/usr/share/elasticsearch/data
    ulimits:
      memlock:
        soft: -1
        hard: -1

volumes:
  es_data:
```

Production note: Requires `vm.max_map_count=262144` on the host (`sysctl -w vm.max_map_count=262144`). Security is disabled above for local dev only — do not do this in production.

### OpenSearch

```yaml
services:
  opensearch:
    image: opensearchproject/opensearch:2.19.0
    environment:
      - discovery.type=single-node
      - OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
      - DISABLE_INSTALL_DEMO_CONFIG=true   # skip demo security config
      - DISABLE_SECURITY_PLUGIN=true       # dev only
    ports:
      - "9200:9200"
    volumes:
      - os_data:/usr/share/opensearch/data
    ulimits:
      memlock:
        soft: -1
        hard: -1

  opensearch-dashboards:
    image: opensearchproject/opensearch-dashboards:2.19.0
    ports:
      - "5601:5601"
    environment:
      - OPENSEARCH_HOSTS=http://opensearch:9200
      - DISABLE_SECURITY_DASHBOARDS_PLUGIN=true  # dev only
    depends_on:
      - opensearch

volumes:
  os_data:
```

Same as Elasticsearch: requires `vm.max_map_count=262144` on the host.

### Meilisearch

```yaml
services:
  meilisearch:
    image: getmeili/meilisearch:v1.12
    ports:
      - "7700:7700"
    environment:
      - MEILI_ENV=development        # use 'production' in prod + set master key
      # - MEILI_MASTER_KEY=your-secret-key   # required in production
    volumes:
      - meili_data:/meili_data

volumes:
  meili_data:
```

That's it. Genuinely. No ZooKeeper, no JVM heap tuning, no `vm.max_map_count`. Access at `http://localhost:7700`.

### Typesense

```yaml
services:
  typesense:
    image: typesense/typesense:27.1
    ports:
      - "8108:8108"
    environment:
      - TYPESENSE_API_KEY=your-api-key    # required even in dev
      - TYPESENSE_DATA_DIR=/data
    volumes:
      - ts_data:/data
    command: ["--data-dir=/data", "--api-key=your-api-key"]

volumes:
  ts_data:
```

Access at `http://localhost:8108`. The API key is mandatory (no keyless mode). The `typesense` volume keeps data persistent across restarts.

---

## 5. Node.js Client Status

| Engine | Package Name | Weekly Downloads (approx) | Last Active | ESM Support | TypeScript | Maintenance |
|--------|-------------|--------------------------|-------------|-------------|------------|-------------|
| Apache Solr | `solr-client` | ~2,000 | 2022 (4 years stale) | No | Via `@types/solr-client` (partial) | Abandoned |
| Apache Solr | `solr-node` | ~1,000 | 2019 (7 years stale) | No | No | Abandoned |
| Elasticsearch | `@elastic/elasticsearch` | ~2,000,000+ | Active (weekly releases) | Yes | Full (built-in, v8+) | Official / Excellent |
| OpenSearch | `@opensearch-project/opensearch` | ~200,000+ | Active (v3.0 released 2025) | Yes | Full (spec-generated v3.0+) | Official / Good |
| Meilisearch | `meilisearch` | ~93,000 | Active | Yes | Full (built-in) | Official / Excellent |
| Typesense | `typesense` | ~80,000 | Active | Yes (builds CJS + ESM) | Full (built-in) | Official / Good |

### Notes

**Solr:** There is no official Apache Solr Node.js client. The community-maintained `solr-client` package (by lbdremy) is the standard reference implementation, but it hasn't been meaningfully updated since 2022 and lacks TypeScript definitions. If you must use Solr with Node.js, you're either maintaining a fork or hitting the Solr HTTP API directly with `fetch`. This is a significant practical problem.

**Elasticsearch:** `@elastic/elasticsearch` is arguably the best search client in the Node.js ecosystem. Full TypeScript types (v8+), native ESM, async generators for scroll/point-in-time, connection pooling, retry logic, and excellent documentation. Version 8+ requires Node.js v20+.

**OpenSearch:** The v3.0 client is a meaningful upgrade — TypeScript types are now generated directly from the OpenSearch API specification rather than handwritten, which means better accuracy and reduced lag between server features and client types. The API is nearly identical to the Elasticsearch client (forked from it), so migration is straightforward.

**Meilisearch:** The `meilisearch` JS client is well-maintained, fully typed, supports ESM, and has a clean API that reflects Meilisearch's philosophy of simplicity. ~93k weekly downloads shows solid adoption. Works in browsers too.

**Typesense:** The `typesense` package is official, fully typed TypeScript-first, and supports both browser and Node.js. The build produces CJS and ESM artifacts. The API wraps Typesense's REST API cleanly.

---

## 6. Feature Matrix

| Feature | Solr | Elasticsearch | OpenSearch | Meilisearch | Typesense |
|---------|------|--------------|------------|-------------|-----------|
| **Full-text search** | Yes | Yes | Yes | Yes | Yes |
| **Typo tolerance / fuzzy** | Yes (levenshtein, configurable) | Yes (fuzziness param) | Yes (fuzziness param) | Yes (automatic, adaptive) | Yes (automatic, adaptive) |
| **Prefix search** | Yes | Yes | Yes | Yes | Yes |
| **Highlighting** | Yes | Yes | Yes | Yes | Yes |
| **Faceted search** | Yes (powerful) | Yes (aggregations) | Yes (aggregations) | Yes | Yes |
| **Filtering** | Yes | Yes | Yes | Yes | Yes |
| **Sorting** | Yes | Yes | Yes | Yes | Yes |
| **Geosearch** | Yes | Yes | Yes | Yes | Yes |
| **Synonyms** | Yes | Yes | Yes | Yes (one-way + equivalents) | Yes (one-way + equivalents) |
| **Stop words** | Yes | Yes | Yes | Yes | Yes |
| **Phonetic search** | Yes (Metaphone, Soundex) | Yes (phonetic plugin) | Yes (phonetic plugin) | No | No |
| **Stemming** | Yes | Yes | Yes | No (uses typo tolerance instead) | No |
| **Custom ranking / boosting** | Yes | Yes | Yes | Yes (custom ranking rules) | Yes (custom ranking rules) |
| **Federated / multi-index search** | Yes | Yes | Yes | Yes (multi-search) | Yes (federated) |
| **Vector / semantic search** | Yes (kNN, Solr 9+) | Yes (dense_vector, mature) | Yes (k-NN plugin) | Yes (hybrid search, built-in) | Yes (hybrid search, built-in) |
| **Hybrid search (BM25 + vector)** | Yes (ACORN, Solr 10) | Yes | Yes | Yes (RRF) | Yes (RRF) |
| **Built-in embedding generation** | No | No (inference API, paid tier) | No | Yes (via integrations) | Yes (built-in models: S-BERT, E5) |
| **Analytics / aggregations** | Yes (facets, pivot) | Yes (best in class) | Yes | Limited (basic counts) | Limited (basic counts) |
| **Log / time-series support** | Partial | Yes (ECS, ILM) | Yes (ILM) | No | No |
| **Multi-tenant / access control** | Yes | Yes | Yes | Partial (multi-index) | Partial (scoped API keys) |
| **Scoped API keys** | No | Yes | Yes | Yes | Yes |
| **Custom analyzers / tokenizers** | Yes (XML config) | Yes (REST config) | Yes (REST config) | Limited | Limited |
| **Schema-on-write** | Yes (schema.xml or managed) | No (schemaless) | No (schemaless) | No (auto-detected) | Yes (explicit schema required) |
| **Replication** | Yes (SolrCloud) | Yes | Yes | No (single node free) | Yes (Raft-based) |
| **Horizontal sharding** | Yes (SolrCloud) | Yes | Yes | Enterprise license only | No (replication only) |
| **Snapshots / backups** | Yes | Yes | Yes | Yes (local) / S3 (EE) | Yes |
| **Dashboard / UI** | Yes (Solr Admin UI) | Yes (Kibana, paid features) | Yes (Dashboards, free) | Yes (mini dashboard at :7700) | No (third-party only) |
| **REST API** | Yes | Yes | Yes | Yes | Yes |
| **GraphQL** | No | No | No | No | No |

---

## 7. Performance Characteristics

### Apache Solr

Solr's performance is competitive with Elasticsearch for query throughput at scale, but it carries JVM startup overhead and requires careful tuning. Its strength is handling very large indexes with complex facets and boost functions, especially in enterprise environments with dedicated ops teams who know how to tune the JVM heap, OS caching, and Lucene index segments.

**Excels at:** High-volume query loads with complex Lucene queries, large-scale enterprise installations, Solr-specific features like Streaming Expressions for aggregation pipelines.

**Struggles with:** Low-latency requirements (JVM cold start + GC pauses), fast indexing under write-heavy loads, operational simplicity.

### Elasticsearch

The benchmark king for distributed search. Elasticsearch's distributed architecture allows it to scale query throughput horizontally, and its query DSL can express arbitrarily complex aggregation pipelines. Recent benchmarks show Elasticsearch can be 40-140% faster than OpenSearch on certain workloads, though this varies significantly by workload type.

**Excels at:** Log analytics (its home turf), aggregations over massive datasets, complex query DSL, time-series data with index lifecycle management, mature vector search.

**Struggles with:** Operational cost (JVM, cluster management), out-of-the-box developer experience, being affordable when you include Kibana's paid tiers.

### OpenSearch

OpenSearch performance is comparable to Elasticsearch (same underlying Lucene), with some documented gaps. OpenSearch 3.0's upgrade to Lucene 10 (April 2025) closed some of those gaps. The 40-140% performance advantage Elasticsearch showed in some benchmarks has been shrinking as OpenSearch optimizes its fork. For most workloads, any difference is irrelevant compared to the licensing win.

**Excels at:** Same workloads as Elasticsearch, plus free security features (auth, encryption, alerting, anomaly detection) that cost extra with Elastic.

**Struggles with:** The same operational complexity as Elasticsearch. Occasionally lags Elasticsearch in feature velocity (though this is improving with OpenSearch 3.0+).

### Meilisearch

Meilisearch's indexing performance is the most striking data point: benchmarks show it indexing up to 7x faster than Elasticsearch or PostgreSQL on equivalent hardware. This is because Meilisearch pre-computes relevancy during indexing rather than at query time, and its Rust implementation avoids JVM overhead. Query latency is excellent for datasets up to tens of millions of documents.

The trade-off: once your dataset size exceeds available RAM (on the free MIT tier), performance degrades. Meilisearch is memory-mapped (uses LMDB), so it can handle data larger than RAM, but you'll see latency spikes as the OS swaps pages. Unlike Typesense, it doesn't require all data in RAM.

**Excels at:** Developer velocity, indexing throughput, small-to-medium datasets (up to ~tens of millions of docs), search-as-you-type UX, typo tolerance without tuning.

**Struggles with:** Datasets requiring horizontal sharding (EE only), complex aggregation queries, log analytics, anything that needs deep Lucene/Elasticsearch query DSL expressiveness.

### Typesense

Typesense is designed to keep its entire index in RAM, which makes it genuinely fast. A fresh instance uses ~30MB; 1 million Hacker News titles use ~165MB. Sub-50ms latency is not a marketing claim — it's a design guarantee when data fits in RAM.

The RAM requirement is both its strength and ceiling. With 32GB of RAM you can handle large datasets comfortably. Beyond that, your options are buying more RAM or... buying more RAM, because horizontal scaling adds redundancy but not capacity (Raft replication, not sharding).

**Excels at:** Absolute lowest latency for search-as-you-type, simplest operational model, Algolia-compatible use cases, real-time index updates (Typesense re-indexes asynchronously and doesn't block reads).

**Struggles with:** Datasets larger than available RAM per node, complex analytics aggregations, log analytics, phonetic search.

---

## 8. Operational Complexity

### Apache Solr

**Complexity: Very High**

Solr's operational model is the most demanding in this list:

- **JVM tuning:** Solr runs on the JVM. You need to configure heap size (typically 50% of system RAM), garbage collection settings, and off-heap memory limits. Getting this wrong causes GC pauses under load.
- **ZooKeeper:** SolrCloud (the production clustering mode) requires a separate ZooKeeper ensemble (minimum 3 nodes for production HA). This is a separate technology stack to operate, monitor, and maintain.
- **Configuration:** Solr uses XML files (`solrconfig.xml`, `schema.xml`) that require restarts or Solr Config API calls to update. The managed schema API helps but the mental model is still complex.
- **Collection/shard management:** Creating collections, managing shard counts, rebalancing — all manual operations requiring Solr expertise.
- **SolrCloud stability:** The ZooKeeper dependency creates fragility. ZooKeeper timeouts can destabilize the entire cluster. Collections count in the low hundreds before stability becomes a concern.

**Minimum RAM for useful operation:**
- Standalone: 2GB (1GB JVM heap + OS overhead)
- SolrCloud: 3 nodes × 2GB + 3 ZooKeeper nodes × 512MB = ~7.5GB minimum

**Hardware recommendation:** 8GB+ RAM per Solr node in production. SSD storage strongly recommended.

### Elasticsearch

**Complexity: High**

Elasticsearch is more operator-friendly than Solr (REST-based config, no ZooKeeper in modern versions), but still demands serious operational investment:

- **JVM:** Same JVM heap tuning requirements as Solr. Elastic recommends setting heap to 50% of system RAM, no more than 32GB (due to compressed OOP threshold).
- **`vm.max_map_count`:** Requires a host-level sysctl change (`vm.max_map_count=262144`). Forget this and you'll get cryptic errors.
- **Shard management:** Choosing the right number of shards per index at creation time matters a lot — you can't change it without reindexing. Oversharding is a common operational mistake.
- **Index lifecycle management:** For time-series data (logs), you need ILM policies to roll over and delete old indices. Non-trivial to configure correctly.
- **Security:** Default security is now enabled in recent versions. TLS/cert management in clusters adds complexity.
- **No ZooKeeper (7.0+):** Elasticsearch replaced ZooKeeper with its own consensus mechanism (Zen2 / cluster coordination), which is a significant operational simplification over Solr.

**Minimum RAM:** 4GB (1GB JVM heap per node is the absolute minimum Elastic recommends; 8GB+ per node for anything real).

### OpenSearch

**Complexity: High (same as Elasticsearch)**

OpenSearch carries the same operational model as Elasticsearch — same JVM, same shard management, same `vm.max_map_count` requirement. The OpenSearch Dashboards (Kibana equivalent) is included free and provides reasonable cluster monitoring UI.

Notable operational advantage over Elasticsearch: security features (auth, TLS, field-level security, audit logging) are free and built-in. With Elasticsearch you're paying for the security tier.

**Minimum RAM:** Same as Elasticsearch. 4GB per node to function; 8GB+ for production workloads.

### Meilisearch

**Complexity: Very Low**

This is where Meilisearch earns its reputation as the developer-friendly option:

- **Single binary / single container:** No JVM, no ZooKeeper, no shard configuration. One process, one volume mount.
- **Zero-config start:** A master key in the environment and you're done.
- **REST configuration:** All configuration (indexes, settings, synonyms, ranking rules) via REST API calls. No config files, no restarts required.
- **Automatic schema inference:** Documents are schemaless by default. Index a JSON document and it works.
- **Memory model:** LMDB memory-mapped storage means it can handle data larger than RAM without explicit configuration, though performance degrades for hot data that doesn't fit.
- **Horizontal scale limitation:** Single-node for the MIT tier. The BUSL Enterprise Edition adds sharding.

**Minimum RAM:** ~512MB is enough to start. Production sizing: plan for 2-3x your indexed dataset size in RAM for hot-path performance.

### Typesense

**Complexity: Very Low**

Typesense is even simpler to start than Meilisearch in some ways:

- **Single binary / single container:** Written in C++, no JVM. Tiny resource footprint.
- **One required config:** An API key. That's the only mandatory parameter.
- **Explicit schema:** Unlike Meilisearch's auto-detection, Typesense requires you to define collection schemas upfront. This is a mild complexity increase but aids correctness.
- **Clustering:** The Raft-based clustering is operationally simpler than Elasticsearch's shard management, but still requires running 3 nodes for HA (like any Raft cluster).
- **RAM-first model:** Plan for 2-3x dataset size in RAM. Run out of RAM and indexing will fail.

**Minimum RAM:** 30MB at startup + 2-3x indexed data size. For 10M product records, expect 2-8GB depending on field density.

---

## 9. Verdict

### TL;DR Ranking for This Project's Priorities

Given the stated priorities (open source, no payment required, Node.js quality, Docker presence):

| Rank | Engine | Why |
|------|--------|-----|
| 1 | **OpenSearch** | Apache 2.0, excellent Docker, good Node.js client (v3.0+), full-featured |
| 2 | **Meilisearch** | MIT (core), best Node.js DX, simplest Docker, best for product/app search |
| 3 | **Typesense** | GPL-3.0, excellent Node.js client, simplest ops, but RAM-constrained |
| 4 | **Elasticsearch** | Best ecosystem, but ELv2 binary license disqualifies "truly open source" |
| 5 | **Apache Solr** | Apache 2.0 but Node.js client is abandoned and ops complexity is brutal |

### Detailed Recommendations

**If you need distributed search at scale with zero licensing risk:** Use **OpenSearch**. It's the only Apache 2.0 engine with Elasticsearch-class distributed capabilities. The Node.js client v3.0 is solid. The operational complexity is real (JVM, shard planning, `vm.max_map_count`) but this is the cost of distributed search. OpenSearch 3.0 on Lucene 10 is a meaningful milestone — this project is not stagnating.

**If you're building product search, documentation search, or app search:** Use **Meilisearch**. The MIT core has everything you need. The Node.js client is excellent. Docker is a single container with no dependencies. Typo tolerance works automatically without tuning. Indexing is dramatically faster than the JVM-based alternatives. The single-node limitation only becomes a problem at a scale where you have the engineering resources to either buy the EE license or migrate. 99% of projects never hit that wall.

**If you need Algolia-style latency and simplicity:** Use **Typesense**. Sub-50ms search as a baseline, simplest possible setup, excellent TypeScript client. GPL-3.0 is genuinely open source. The RAM requirement is the only real constraint. If your dataset fits in RAM and you're not in a corporate environment with GPL phobia, this is a great choice.

**If you need Elasticsearch but licensing is a concern:** Use **OpenSearch**. Full stop. The API is compatible enough that migration from Elasticsearch 7.x is straightforward.

**If you're already on Elasticsearch and licensing isn't a hard constraint:** Stay on **Elasticsearch**. The ecosystem maturity, Kibana, the `@elastic/elasticsearch` client, and the depth of the query DSL are hard to beat. ELv2 is permissive enough for internal self-hosted use. Just don't try to build a managed search-as-a-service business on top of it.

**Avoid Apache Solr for new projects.** The only legitimate reasons to choose Solr in 2026 are: (1) you're already running it and migration cost exceeds the pain, (2) you specifically need its phonetic search or Streaming Expressions capabilities, or (3) you have Solr expertise in-house and are building on existing investment. The abandoned Node.js client alone is disqualifying for a Node.js-first project. Solr's XML configuration model, ZooKeeper dependency, and steep learning curve offer nothing that OpenSearch doesn't also provide with a better developer experience.

### The Honest Take on Elasticsearch Licensing

Elastic's "return to open source" in 2024 is real but incomplete. The source code is now available under AGPL, which is a genuine OSI-approved license. But the binaries you download from elastic.co remain under Elastic License 2.0. If you want to run Elasticsearch under AGPL, you'd need to build it from source yourself — and most teams aren't doing that. Elastic's marketing framing of this as "returning to open source" is technically defensible but practically misleading. The product you run day-to-day is still ELv2. Community trust won't fully recover until Elastic ships ELv2-free binary releases, which they haven't announced.

### The Honest Take on Meilisearch's BUSL

The BUSL Enterprise Edition features (sharding, S3 snapshots, IRSA) are genuinely advanced features that most teams never need. This is not a bait-and-switch in the style of Redis or Elastic's 2021 switch — the core engine is MIT and fully functional for the vast majority of use cases. The BUSL EE split is closer to how Sentry or GitLab operate: open core with enterprise add-ons. The concern would be if Meilisearch starts moving critical features into EE over time. Watch for that, but it hasn't happened yet.

---

## Sources

- [Apache Solr Official Docker Image](https://hub.docker.com/_/solr)
- [Apache Solr Docker GitHub](https://github.com/apache/solr-docker)
- [Elastic's Return to Open Source (Revenera)](https://www.revenera.com/blog/software-composition-analysis/elastics-return-to-open-source/)
- [Elastic FAQ on Licensing](https://www.elastic.co/pricing/faq/licensing)
- [Elasticsearch Is Open Source. Again! (Elastic Blog)](https://www.elastic.co/blog/elasticsearch-is-open-source-again)
- [Doubling down on open, Part II (Elastic Blog)](https://www.elastic.co/blog/licensing-change)
- [Developers Burned by Elasticsearch License Change Aren't Going Back (Socket.dev)](https://socket.dev/blog/developers-burned-by-elasticsearch-license-change-arent-going-back)
- [Stepping up for a truly open source Elasticsearch (AWS)](https://aws.amazon.com/blogs/opensource/stepping-up-for-a-truly-open-source-elasticsearch/)
- [OpenSearch vs. Elasticsearch: A Comprehensive Comparison in 2025 (Medium)](https://medium.com/@FrankGoortani/opensearch-vs-elasticsearch-a-comprehensive-comparison-in-2025-aff5a8533422)
- [OpenSearch in 2025: Much more than an Elasticsearch fork (InfoWorld)](https://www.infoworld.com/article/3971473/opensearch-in-2025-much-more-than-an-elasticsearch-fork.html)
- [OpenSearch Software Foundation 1-Year Anniversary (Linux Foundation)](https://www.linuxfoundation.org/press/opensearch-software-foundation-marks-1-year-anniversary-with-community-growth-agentic-ai-and-hybrid-search-enhancements/)
- [Introducing OpenSearch JavaScript client 3.0](https://opensearch.org/blog/introducing-opensearch-js-client-3-0/)
- [Meilisearch Enterprise Edition License](https://www.meilisearch.com/blog/enterprise-license)
- [Meilisearch Enterprise and Community Editions (Docs)](https://www.meilisearch.com/docs/learn/self_hosted/enterprise_edition)
- [Meilisearch GitHub](https://github.com/meilisearch/meilisearch)
- [meilisearch-js GitHub](https://github.com/meilisearch/meilisearch-js)
- [meilisearch npm package](https://www.npmjs.com/package/meilisearch)
- [Typesense GitHub](https://github.com/typesense/typesense)
- [Typesense GPL-3.0 License Discussion](https://github.com/typesense/typesense/issues/116)
- [Typesense Features Documentation](https://typesense.org/docs/overview/features.html)
- [typesense-js GitHub](https://github.com/typesense/typesense-js)
- [typesense npm package](https://www.npmjs.com/package/typesense)
- [Apache Solr System Requirements](https://solr.apache.org/guide/solr/latest/deployment-guide/system-requirements.html)
- [solr-client npm (abandoned)](https://www.npmjs.com/package/solr-client)
- [@elastic/elasticsearch npm](https://www.npmjs.com/package/@elastic/elasticsearch)
- [@opensearch-project/opensearch npm](https://www.npmjs.com/package/@opensearch-project/opensearch)
- [Benchmarking Performance: Elasticsearch vs Competitors (Gigasearch/Medium)](https://medium.com/gigasearch/benchmarking-performance-elasticsearch-vs-competitors-d4778ef75639)
- [Typesense vs Algolia vs Elasticsearch vs Meilisearch (Typesense)](https://typesense.org/typesense-vs-algolia-vs-elasticsearch-vs-meilisearch/)
- [Meilisearch vs Typesense](https://www.meilisearch.com/blog/meilisearch-vs-typesense)
- [Apache Solr Dense Vector Search](https://solr.apache.org/guide/solr/latest/query-guide/dense-vector-search.html)
- [Faster Vector Search in Apache Solr (Sease, 2025)](https://sease.io/2025/12/faster-vector-search-early-termination-strategy-now-in-apache-solr.html)
- [Elasticsearch vs. Solr: What Developers Need to Know in 2025 (Last9)](https://last9.io/blog/elasticsearch-vs-solr/)
- [Typesense System Requirements](https://typesense.org/docs/guide/system-requirements.html)
- [Install Elasticsearch with Docker (Elastic Docs)](https://www.elastic.co/guide/en/elasticsearch/reference/current/docker.html)
- [OpenSearch Docker Documentation](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/)
