# Backend implementation cards and donor decision register

Date: 2026-10-08  
Audited source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`  
Execution router: [`docs/implementation/backend-entrypoints.md`](../../../docs/implementation/backend-entrypoints.md)

This is the short implementation companion to the final PR matrix and donor playbooks. It is not a
new queue. The active PR owns acceptance; this file tells an implementation agent which existing Eliot
owner to extend, which isolated donor invariant to use, and which tempting duplicate must not be built.

## 1. Decision vocabulary

| Decision | Meaning |
|---|---|
| `PLATFORM` | Cloudflare already owns the commodity mechanism. Write only the narrow Eliot adapter/receipt. |
| `ADOPT` | Bring the named invariant into an existing Eliot owner. Do not import the donor runtime. |
| `ALREADY_STRONGER` | Eliot already has a stronger authority contract. Borrow only tests or presentation details. |
| `DEFER_UNTIL_MEASURED` | Do not implement until a named workload/evaluation gate proves the need. |
| `REJECT_CORE` | The donor mechanism would create a duplicate runtime/store/registry or violate the Worker boundary. |

## 2. Non-negotiable Cloudflare ownership

| Capability | Decision | Implementation boundary |
|---|---|---|
| Hybrid BM25 + vector retrieval, RRF/max fusion, reranking, metadata filtering | `PLATFORM` | One scoped AI Search ranked list. Eliot rechecks authority, resolves exact evidence, records coverage and bounded backfill. |
| File upload/indexing/status and built-in search storage | `PLATFORM` | Existing Items adapter and generation registry. Eliot owns desired manifest, exact readback, qualification and promotion. |
| Durable retries, delays, sleep, timeout and external-event wait | `PLATFORM` | Cloudflare Workflows is the sole generic execution runtime. Eliot keeps a full attempt ledger only for unknown external effects. |
| Queue redelivery, `max_retries`, DLQ, concurrency and backlog metrics | `PLATFORM` | Cloudflare owns terminal transport delivery. Eliot keeps canonical D1 outbox/inbox and business settlement. |
| WebSocket transport, persisted chat messages, resumable streams, typed data parts | `PLATFORM` | `AIChatAgent`/`WebSocketChatTransport` own presentation transport. Research authority stays in D1/R2/Workflow. |
| Website crawl, static/browser capture, Markdown/JSON output, incremental recrawl | `PLATFORM` | Browser Run/Markdown are acquisition transports. Results still pass raw capture, extraction and source admission. |
| Infrastructure traces and platform usage metrics | `PLATFORM` | Workers/Agents traces and native analytics. Eliot adds semantic IDs and safe receipt correlation, not another telemetry backend. |

If a task proposes a vector database, custom workflow server, generic agent graph runtime, crawler
platform, WebSocket resume protocol, DLQ service or telemetry backend, stop: the design is crossing this
boundary.

## 3. Donor decision register

### 3.1 Adopt now inside existing owners

| Donor mechanism | Decision | Eliot owner | Exact adaptation |
|---|---|---|---|
| WeKnora best-rank-per-identity RRF | `ADOPT` | #242, `packages/retrieval/src/fusion.ts` | One contribution per canonical identity per physical ranked list; preserve raw/provider rank provenance. |
| Agentset bounded filter AST/capability rejection | `ADOPT` | #320/#242 | Server-owned allowlisted subset only; ACL/scope predicate is not client-controlled. No regex/raw provider filter strings. |
| LightRAG complete-or-raise scheduling reads and typed cursor | `ADOPT` | #244 | Apply to existing D1 desired-manifest reconciliation. Do not create a new document scheduler/store. |
| Onyx generation readiness/swap gates | `ADOPT` | #244 | Required-set manifest, no writers/reconciliation in flight, exact target readback, existing CAS/pointer. |
| Open Notebook typed extraction boundary | `ADOPT` | #231/#239 | Effective engine, empty-vs-failed extraction, safe user error and operator cause. No LangGraph runtime. |
| Onyx connector capability split/per-item failures | `ADOPT` | future connector work after #231/#239 | Full/poll/slim/permission/checkpoint/resolver shapes; not a connector framework in #231. |
| DocsGPT context planning before rendering | `ADOPT` | #233 | Required/optional evidence decisions, output/tool/schema reserve and explicit omissions inside existing context compiler. |
| SurfSense server-issued citation ordinals and source-tag defanging | `ADOPT` | #233/#261 | Short aliases resolve only to existing `EvidenceHandle`s; invented aliases removed; untrusted excerpts cannot close envelopes. |
| SurfSense structural splitting and line provenance | `ADOPT` | #239/#240 | Qualify stable normalized spans/line mapping. Existing canonical sections remain the identity owner. |
| WeKnora atomic revision + optimistic lock + rollback-as-new-revision | `ADOPT` where missing | #246/#247 over existing Artifact COW/Wiki stores | Do not create a new artifact/wiki store. Add only missing edit-source/conflict/rollback invariants and tests. |
| Cognee server-issued fact aliases/non-destructive contradiction proposals | `ADOPT` | #214 | Candidate relation only; exact Eliot handles/fact revisions remain authority. |
| Graphiti temporal validity/provenance fields | `ADOPT` narrowly | #249 after #248 | Relation revisions may carry observed/valid/invalid/superseded times. No graph database or automatic truth promotion. |
| Promptfoo per-assertion result shape + BEIR metric definitions | `ADOPT` | #285 | Deterministic hard gates first, immutable expected-case/run manifests, metrics second, judges last. |
| Khoj unchanged-chunk hash reuse | `ADOPT` only under generation owner | #244/#239 | SHA-256/BLAKE3 + parser/chunker/model fingerprints; never use destructive regenerate. |

### 3.2 Eliot already has the stronger core

| Donor idea | Decision | Existing Eliot owner | Allowed borrowing |
|---|---|---|---|
| SurfSense citation IDs | `ALREADY_STRONGER` | `EvidenceHandle`, exact resolver, AllowedReferenceManifest | Ordinal UX and forgery tests only. No second citation registry. |
| WeKnora Wiki revision store | `ALREADY_STRONGER` in core shape | Artifact COW, Wiki revisions, publication policy | Optimistic-conflict/rollback tests and explicit edit provenance only. |
| OpenViking sidecar summaries/context hierarchy | `ALREADY_STRONGER` for Research | SourceCard, DocumentMap, ProjectAtlas, artifact revisions | Freshness/validation/reconciliation rules only. No `viking://` filesystem. |
| RAGFlow/Dify checkpoints | `ALREADY_STRONGER` platform owner | Cloudflare Workflows + Eliot effect settlement | Crash/restart, completed-node-no-rerun and emitted-cursor test cases only. |
| Onyx ACL query choke point | `ALREADY_STRONGER` authority model | Frozen scope, owner/purge/currentness, #320 provider prefilter, exact resolver | Test every retrieval mode uses the same server-owned scope compiler. |
| Microsoft GraphRAG table artifacts | `ALREADY_STRONGER` materialization model | Artifact COW and immutable referenced objects | Diagnostic stage-artifact receipts only; no GraphRAG runtime. |
| Haystack typed component contract | `ALREADY_STRONGER` for fixed Research topology | Versioned stage/request/output schemas and fixed 18-stage Workflow | Lightweight-constructor/signature compatibility tests for adapters only. |

### 3.3 Defer until a measured need exists

| Donor mechanism | Decision | Trigger |
|---|---|---|
| PipesHub hierarchical DRR/heavy-light scheduler | `DEFER_UNTIL_MEASURED` | #288 demonstrates starvation or unfairness that cannot be solved with separate Cloudflare Queues/consumers and native concurrency. |
| MaxKB multilingual query rewriting | `DEFER_UNTIL_MEASURED` | Golden multilingual/code/version queries show a repeatable recall gap after managed AI Search configuration. |
| OpenViking best-first hierarchical traversal | `DEFER_UNTIL_MEASURED` | Flat managed hybrid retrieval versus DocumentMap-guided traversal benchmark proves quality/cost benefit. |
| Graph/PPR reranking | `DEFER_UNTIL_MEASURED` | Exact relation overlay exists and Golden cases prove benefit over normal managed retrieval/rerank. |
| Provider-neutral vector-store registry | `DEFER_UNTIL_MEASURED` | A second selected search provider is qualified. Current core uses the selected Cloudflare instance/bindings. |
| Text Fragment deep links | `DEFER_UNTIL_MEASURED` / UI owner | Exact browser-source highlighting is selected by #329 after EvidenceHandle resolution; never citation authority. |
| Local desktop SQLite patterns | `DEFER_UNTIL_MEASURED` | A separately selected desktop product exists. They do not belong in the Cloudflare backend. |

### 3.4 Reject from the backend core

| Mechanism | Decision | Reason |
|---|---|---|
| LangChain/LangGraph/Dify/RAGFlow/Haystack generic runtime | `REJECT_CORE` | Duplicates Cloudflare Workflows and the fixed Research protocol. Import test invariants, not runtime. |
| Neo4j/Arango/GraphRAG database | `REJECT_CORE` | D1 relation overlay is sufficient until measured otherwise; exact evidence remains primary. |
| OpenViking context filesystem | `REJECT_CORE` | Duplicates R2/D1 source/artifact/navigation owners and creates another namespace/permission model. |
| Custom crawler/browser farm | `REJECT_CORE` | Browser Run/Markdown/Web Search already provide acquisition transport. |
| Custom vector/keyword/rerank engine | `REJECT_CORE` | AI Search owns relevance. Eliot owns query identity, authority, evidence and coverage. |
| Second citation registry | `REJECT_CORE` | `EvidenceHandle` and AllowedReferenceManifest are canonical. |
| Second artifact/wiki store | `REJECT_CORE` | Artifact COW/Wiki publication already own revisions and immutable objects. |
| Generic plugin/component marketplace | `REJECT_CORE` | Expands attack/dependency surface without a selected product need. |
| LLM summary/entity output as canonical source | `REJECT_CORE` | Derived output requires validation/version/provenance and never replaces admitted source bytes. |
| Delete-before-rebuild indexing | `REJECT_CORE` | A failed build must not destroy the active generation. |

## 4. First-wave implementation cards

### Card A — #209 first cause and citation outcomes

```text
Start:
  active PR #209 / R00
  failure-model.md
  current D1 failure migrations/guards and status readers

Existing owners to extend:
  resolveCitationSet
  recordWorkflowFailure / retainWorkflowFailure
  current Workflow failure codecs and public status sanitization

Donor invariant:
  Open Notebook safe user/operator error split
  LightRAG durable-reference-intact/unknown outcome dimension

Must remove/retire:
  catch-all mapping of known domain failures to generic retryable uncertainty
  invalid-evidence classification for verifier/storage unavailability

Do not add:
  second failure table, Result framework, telemetry framework

Done when:
  TypeScript and SQL accept the same forward vocabulary;
  first cause survives later failures;
  unknown effect is not retried blindly;
  public status stays bounded and redacted.
```

### Card B — #321 then #331 common bounded body reader

```text
Start:
  packages/platform-cloudflare/src/runtime-limits.ts
    readStreamWithinBytes / readResponseBodyWithinBytes
  provider-config-rest-response.ts
  custom-provider-rest-response.ts
  packages/cloudflare-workflows/src/objects.ts
  packages/cloudflare-evidence/src/content-store.ts

Donor invariant:
  none needed; the common Eliot primitive already owns the correct mechanism

Must remove/retire:
  private full-body readStream/cancelQuietly copies
  blocking cancellation cleanup

Do not add:
  generic HTTP client/framework or permissive JSON decoder

Done when:
  all complete-body callers use one primitive;
  specialized line seek remains streaming;
  hostile cancellation/chunk flood/mutable-buffer/lock cases are bounded;
  net production LOC decreases.
```

### Card C — #322 + #323 retrieval invariants

```text
Start:
  packages/retrieval/src/planner.ts
  packages/retrieval/src/fusion.ts
  existing retrieval tests

Donor invariant:
  WeKnora best rank per identity belongs later in #242

Must remove/retire:
  ambiguous delimiter key
  planner predicate that accepts a direct lane after SEM

Do not add:
  planner framework, new persisted identity, schema migration

Done when:
  every direct lane precedes semantic;
  distinct tuple identities never collide;
  same identity still deduplicates;
  focused package checks pass.
```

### Card D — #324 + #320 then #242 managed retrieval integration

```text
Start:
  packages/platform-cloudflare/src/ai-search.ts
  packages/platform-cloudflare/src/ai-search-scope-filter.ts
  packages/cloudflare-projection/src/ai-search-managed-read.ts
  packages/retrieval/src/{service,lanes,fusion}.ts
  research-retrieval-composition.ts

Platform:
  AI Search performs keyword+vector hybrid, native fusion and optional rerank

Donor invariant:
  Agentset explicit supported-filter subset
  WeKnora one contribution per identity per physical list

Must remove/retire:
  vector-only use of the managed instance
  weak phrase-only D1 LEX as primary relevance
  second fusion of provider-internal keyword/vector signals
  duplicate governed lane loop and write-only laneCandidateIds

Do not add:
  vector DB, custom BM25, custom reranker, generic filter language

Done when:
  one scoped managed ranked list enters Eliot;
  provider candidate/resolution/evidence budgets are separate;
  exact authority/currentness and bounded backfill remain;
  trace/result identities settle coherently.
```

### Card E — #332 consistent investigation snapshot

```text
Start:
  packages/research/src/ports.ts
  packages/research/src/investigation-service.ts
  ledger D1 tests

Platform:
  D1 bounded query/batch primitives

Must remove/retire:
  head N followed by unbounded history read that can observe N+1

Do not add:
  lock service, ORM, retry/spin loop, snapshot framework

Done when:
  event read is bounded by the observed head frontier;
  valid concurrent append cannot look like corruption;
  real gaps/duplicates/malformed events still fail.
```

### Card F — #282 emitted artifact budgets

```text
Start:
  scripts/check-budgets.mjs
  installed Wrangler/Vite build commands and emitted manifests

Platform:
  Wrangler owns Worker bundling; Vite owns owner-web build graph

Must remove/retire:
  claims that source relocation/line reduction proves runtime-size reduction

Do not add:
  another bundler or private workers-sdk dependency

Done when:
  reports bind build inputs/SHA/tool versions;
  Worker modules/Wasm and eager/shared/lazy web JS are distinguished;
  missing build is NOT_MEASURED, never zero/pass.
```

## 5. Second-wave implementation cards

### #325 then #214 — branch findings and real counter-search

```text
Reuse:
  planning questions/hypotheses, retrieveWithHeldScope, exact resolver,
  ResearchBranchResult builder, debts, freeze and claim audit

Adopt:
  Open Notebook stage separation; RAGFlow focused query schema;
  Cognee server-issued fact aliases and non-destructive candidates;
  Graphiti temporal overlap concepts only

Remove:
  source_class substring routing;
  handles-only paid branch output;
  automatic counter-handle -> contradiction

Do not add:
  graph DB, second branch scheduler/result hierarchy, second verifier
```

### #330 then #326/#264/#256 — platform execution/transport

```text
Reuse Cloudflare:
  Workflows retry/wait/event, AIChatAgent resumable presentation,
  Queues retry/DLQ/concurrency/metrics

Keep Eliot:
  unknown-effect attempt identity, task/result authority, D1 outbox/inbox,
  scope/currentness/evidence/publication

Remove:
  custom checkpoint engine for safe stages;
  ResearchSession second 18-stage executor;
  normal waiting as uncertainty/poll recovery;
  custom WebSocket resume/history protocol;
  magic application retry ceiling/second DLQ logic
```

### #231 -> #239 -> #240 and #244 — acquisition to searchable exact evidence

```text
Reuse:
  createRawCaptureService, createRawNormalizedAdmissionService,
  existing bundle lifecycle, coordinate-map/evidence resolver,
  managed Items adapter/generation registry

Platform:
  Web Search / Browser Run / Markdown / AI Search OCR as transport/managed parsing

Adopt:
  Open Notebook extraction taxonomy;
  SurfSense stable line/span mapping;
  RAGFlow DocumentIR fields as provider qualification shape;
  LightRAG strict reconciliation;
  Onyx generation readiness

Remove/avoid:
  snippet-as-source, embedded OCR/PDF engine, second source/index store,
  guessed coordinates, delete-before-build
```

### #233 -> #246 -> #247 — products, artifacts and dependencies

```text
Reuse:
  product Workflow, context compiler, AllowedReferenceManifest,
  Artifact COW, Wiki/publication, dependency manifests and outbox/change feed

Adopt:
  DocsGPT plan-before-render context decisions;
  SurfSense ordinal aliases/defanging;
  WeKnora optimistic revision and rollback-as-new-revision tests

Remove/avoid:
  second answer engine, context service, citation registry, artifact store,
  global refresh bus, model-authored evidence identity
```

### #248 -> #249 — atoms and relations

```text
Reuse:
  exact EvidenceHandle/span authority, existing relation ledger, dependency invalidation

Adopt:
  LangExtract-style exact candidate/admission split;
  Graphiti temporal provenance;
  Cognee non-destructive relation proposal

Remove/avoid:
  blanket LLM compilation, graph DB, co-occurrence-as-causality,
  summary/community node as evidence
```

### #328 -> #285 — deterministic quality gate

```text
Reuse:
  Golden corpus, exact handles, traces, claim audit, cost/attempt receipts

Adopt:
  Promptfoo component result shape and BEIR definitions only

Remove/avoid:
  empty/partial case-set pass, one aggregate score, judge as authority,
  cold/warm mixing, threshold tuning on holdout
```

## 6. Reviewer anti-Frankenstein gate

Reject an implementation unless the PR states all of the following:

```text
old active owner/path
new single owner/path
migrated callers
removed or retired duplicate
legacy persisted codec/read path
Cloudflare primitive reused
Eliot semantic authority retained
net production LOC and emitted bundle delta
D1/R2/provider-call delta
negative/replay/lost-ACK/bound checks
remaining PENDING gates
```

A wrapper over two still-active engines is not consolidation. A donor-inspired DTO without a caller,
persistence path, readback and deletion of the obsolete path is not implementation. A provider success
is not evidence, completeness, publication or a permission decision.

## 7. Stop conditions

Stop and return to the integrator when any task would require:

- a new shared contract owner or migration not assigned by the PR;
- a second implementation of an existing authority guarantee;
- a Cloudflare feature replacement without measured insufficiency;
- an optional donor feature becoming a core blocker;
- a cross-manager edit of a shared barrel/manifest/composition root;
- weakening strict evidence/scope/purge/currentness checks to fit provider output.

The desired result is less code and fewer owners: Cloudflare handles commodity execution; one Eliot
owner handles each missing semantic guarantee.
