# Cloudflare AI Search GA and projection sweep

**Reviewed:** 2026-10-24. **Branch baseline:**
[`455809d9`](https://github.com/UnknownAlienHuman/eliot-research/tree/455809d91d0b22bd5d19b75ea082539204b2fd61).

This continuation checks the complete current AI Search changelog, GA announcement, Workers/REST bindings, built-in storage,
index configuration, metadata/filtering, cache, limits, pricing and troubleshooting documentation against Eliot's Library
projection. It distinguishes managed retrieval from canonical storage, authorization, exact evidence and generation. It is
source review, not an instance creation, index migration, query benchmark or billing observation.

## Findings

| # | Evidence and interpretation | Owning correction |
|---|---|---|
| 119 | AI Search became generally available on 2026-10-01 and usage-based billing begins 2026-11-01. Accounts receive separate monthly allowances for ingestion tokens, storage, semantic/vector/hybrid queries and full-text queries. Workers AI embedding and reranking performed internally by AI Search are included in AI Search pricing and no longer appear on the Workers AI bill or in AI Gateway logs; generation, query rewriting and external providers remain separate. | Eliot records AI Search ingestion, storage, semantic/hybrid and full-text usage as a separate cost source. Gateway logs cannot reconcile embedding/reranking cost. Each query record stores retrieval mode, instance/config version, result count and observed provider usage where available. Cost UI separates AI Search projection/query usage from Gateway/model generation and Web Search. Included quotas are alerts, not job budgets. |
| 120 | New instances now default to hybrid search, but hybrid behavior is configurable: vector/keyword index method, `porter` or `trigram` tokenizer, `and`/`or` keyword matching and `rrf`/`max` fusion. The 2026-10-16 CJK release says `porter` performs poorly for Japanese/Chinese/Korean and changing tokenizer triggers a full reindex. Current docs do not establish Russian stemming quality. | Never inherit a changing instance default. Stage 1 commits an explicit retrieval configuration and `search_config_version`. The initial candidate is measured on English and Russian exact identifiers, morphology, tables and long-tail facts before selection. The CJK trigram improvement is not evidence for Russian. Changing tokenizer/index method or another index-shaping setting is a projection migration with reindex, quality comparison and cutover, not an invisible settings edit. |
| 121 | A cross-instance search request accepts at most 10 instances. Paid instances support up to one million files for non-hybrid indexing but 500,000 for hybrid; Free supports 100,000. These limits make an instance-per-project or instance-per-source topology unable to satisfy representative 50/500-source project selections through cross-instance fan-out. | Keep one shared Library instance and express project/frozen selection through short metadata filters resolved from D1. Do not provision an instance per project, source or job. The stage-2 50/500 exercise must prove that the selected metadata/filter representation is accepted and complete; the cross-instance API is not a fallback for an over-wide or truncated scope. Capacity thresholds create an explicit projection-sharding decision, never an automatic topology change. |
| 122 | Items uploaded to built-in storage use a key of at most 128 characters. The key is unique only within a data source; exact lookup should include both key and source. Uploading an existing key returns `409 item_key_already_exist`. `upload()` is asynchronous; `uploadAndPoll()` waits 120 seconds by default and at most 300 seconds, so timeout does not determine whether publication later succeeded. | Use a short deterministic opaque item key derived from immutable revision/kind, record returned item ID and `source=builtin`, and look up that exact pair before any retry. A `409` is reconciliation: compare the D1-recorded revision/config and existing item rather than choosing a random suffix. Publication never overwrites the current key. A replacement revision gets a new key, becomes searchable and is verified before the old projection item is removed. Poll timeout remains `projection_pending` and cannot trigger blind duplicate upload. |
| 123 | Every instance has managed built-in storage and vector index backed by R2/Vectorize. Built-in files can be downloaded through the Items API, while original content download is unavailable for external-source items. Managed storage availability therefore depends on source type and remains inside the AI Search lifecycle. | AI Search bytes are a disposable provider projection, not Eliot's original authority or portable export. Canonical original and normalized bodies remain immutable R2 objects with D1 manifests regardless of whether the item was uploaded to built-in storage. Item download is diagnostic/recovery assistance only. Deleting or rebuilding the instance must not remove the only retained source or break existing exact citations. |
| 124 | AI Search enforces format-specific file ceilings: plain text/code and PDFs with OCR enabled can be up to 10 MiB; PDFs without OCR and other converted formats remain limited to 4 MiB. Oversized files are not indexed. OCR and image processing consume image-processing ingestion tokens; text-only embedding models may generate image captions, while multimodal models embed images directly. Conversion can also fail because generated Markdown or chunks exceed internal limits. | Eliot validates projection size/type before upload and records an explicit projection error instead of treating canonical admission as failed. Large canonical sources are deterministically split into retained projection items with source/page/byte mapping and bounded keys. OCR/captions/image embeddings are labelled generated retrieval aids, never exact textual evidence. Citation hydration returns retained original bytes/page context; conversion warnings and image-processing cost remain visible. |
| 125 | AI Search exposes two distinct query paths: Search returns relevant content chunks for caller-owned generation, while Chat Completions retrieves and generates in one call. Similarity cache reuses generated responses for similar prompts, defaults to 48 hours and only supports configured TTLs from 10 minutes to six days; there is no documented zero-TTL setting. Cache entries are tied to chunks and can be purged instance-wide. | Evidence-sensitive Eliot flows use the raw Search binding/API, hydrate retained chunks and perform generation through the selected Eliot model path. They do not call AI Search Chat Completions or its public/MCP endpoint. This avoids semantically reused generated answers with no disable value. If an explicitly non-evidentiary feature later uses AI Search generation, it must disclose cache status, use the minimum accepted TTL where appropriate, purge on projection/config changes and never promote a cached answer as fresh evidence. |
| 126 | An instance supports five custom metadata fields. Metadata shares a 10 KiB envelope per vector, only the first 64 UTF-8 bytes of an indexed string are filterable, reserved names include `timestamp`, `folder` and `filename`, and field matching is case-insensitive. Relevance boosting supports at most three fields and merely nudges ranking. | Freeze short typed opaque metadata fields once in stage 1; D1 resolves full bibliographic and authorization predicates. Scope filters are assembled server-side and applied before ranking/hydration. A boost is never a project/revision/visibility filter and cannot grant access. Long URLs, hashes, JSON scopes and human labels are not filter keys. Store actual filters and boost profile with the query so a result can be reproduced against the same projection configuration. |
| 127 | Full-text queries and semantic/vector/hybrid queries have different quotas and prices. Hybrid runs vector and BM25 retrieval together; reranking is included in AI Search pricing, but exact identifiers can still be harmed by tokenizer/match/fusion choices. The service limit and pricing model do not choose the correct retrieval mode for each Eliot task. | Record and bound query mode explicitly. Exact source IDs, citation anchors and known identifiers prefer D1/exact lookup or a measured full-text path; open-ended evidence discovery uses the measured hybrid profile. No hidden query rewrite or automatic switch may silently change scope. Benchmark recall/precision, query count, latency and cost separately for English/Russian exact, lexical, semantic and hybrid cases before making a profile default. |
| 128 | Custom metadata schema and tokenizer changes can force a full reindex. Individual external-source files can be reindexed, while built-in uploads are asynchronous items with their own IDs/status. Public endpoints expose unauthenticated search/chat/MCP unless separately protected, and a namespace binding grants full authority over every instance in that namespace. | Treat every index-shaping configuration as a versioned disposable projection. Build/reindex under a recorded config, verify representative filters/results and only then publish the config as current in D1. Keep the product Worker on one pre-existing instance binding; instance/namespace creation, update, purge and deletion remain separate owner setup/maintenance operations. Public Search/Chat/MCP endpoints stay disabled; all product and agent access passes through Eliot authorization and hydration. |

## Selected AI Search profile

```text
runtime authority = one pre-existing ai_search instance binding
canonical authority = D1 manifests + immutable R2 original/normalized bytes
index topology = one shared Library instance
query path = raw Search chunks; Eliot owns hydration and generation
public search/chat/MCP = disabled
instance/namespace administration = owner setup/maintenance token only
item identity = deterministic short revision/kind key + source=builtin + recorded item ID
replacement = publish/verify new revision before deleting old projection item
index configuration = explicit versioned hybrid candidate; no inherited defaults
similarity-generated response cache = unused by evidence flows
metadata = five frozen short typed fields; filters authorize scope; boosts rank only
cost accounting = AI Search ingestion/storage/query meters separate from Gateway/model/Web Search
```

## Required implementation checks

```text
create one isolated instance with explicit index/search configuration
verify product binding lacks namespace create/list/update/delete authority
upload deterministic item and reconcile create-ack/poll timeout by key+source and item ID
observe duplicate-key 409 without random-suffix publication
publish replacement before old-item deletion; verify old/current citation behavior
exercise 4 MiB/10 MiB boundaries and oversized/generated-markdown/chunk failures
prove English/Russian exact/full-text/semantic/hybrid retrieval quality
prove representative 50/500-source filter completeness in one instance
confirm long metadata never becomes a filter and boosts cannot cross scope
compare raw Search against Chat Completions and confirm evidence paths never use generated cache
expire/delete/rebuild projection while D1/R2 export and exact citations remain intact
measure AI Search ingestion/storage/full-text/hybrid usage separately from Gateway generation
verify every public/default endpoint remains unavailable
```

## Primary sources

- [AI Search GA](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/) and
  [limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).
- [AI Search product changelog](https://developers.cloudflare.com/changelog/product/ai-search/) including CJK tokenizer,
  hybrid, namespace, item-key, cache and indexing changes.
- [Hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/),
  [keyword search](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/) and
  [relevance boosting](https://developers.cloudflare.com/ai-search/configuration/retrieval/boosting/).
- [Metadata](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/) and
  [filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/).
- [Items Workers binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/),
  [Items REST API](https://developers.cloudflare.com/ai-search/api/items/rest-api/) and
  [API errors](https://developers.cloudflare.com/ai-search/troubleshooting/api-error-codes/).
- [Built-in storage](https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/) and
  [data-source/file limits](https://developers.cloudflare.com/ai-search/configuration/data-source/).
- [Search versus Chat Completions](https://developers.cloudflare.com/ai-search/api/search/rest-api/) and
  [similarity cache](https://developers.cloudflare.com/ai-search/configuration/retrieval/cache/).
- [Wrangler AI Search bindings](https://developers.cloudflare.com/workers/wrangler/configuration/#ai-search-namespaces).

## Verification boundary

The official current AI Search GA announcement, full product changelog and referenced configuration/API/limits/error pages
were inspected. No instance, namespace, item, cache, sync/reindex job or public endpoint was created, updated, queried,
purged or deleted. No English/Russian retrieval benchmark, 50/500-source scope test, file-limit test, replacement cutover,
billing observation or export/rebuild exercise was run. Those checks remain owned by stages 1–2 and the measured quality
slice.