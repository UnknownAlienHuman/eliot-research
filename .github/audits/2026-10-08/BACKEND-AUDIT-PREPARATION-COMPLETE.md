# Backend audit and implementation preparation — COMPLETE

Date: 2026-10-08  
Audited source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`

```text
BACKEND_AUDIT_PREPARATION_COMPLETE
```

This marker means architecture/code/donor audit has a bounded, non-circular implementation handoff.
It does **not** mean implementation, compiler checks, native Cloudflare qualification, paid model/search
calls, staging or release acceptance is complete.

## 1. Canonical implementation entry points

Read in this order:

1. [`docs/implementation/backend-entrypoints.md`](../../../docs/implementation/backend-entrypoints.md)
2. [`BACKEND-IMPLEMENTATION-CARDS.md`](BACKEND-IMPLEMENTATION-CARDS.md)
3. the assigned active PR/passport
4. its owning ER packet and only the architecture sections named by that packet
5. [`FINAL-PR-DISPOSITION-MATRIX.md`](FINAL-PR-DISPOSITION-MATRIX.md) for dependency/ownership conflicts

The former `docs/implementation/backend-delivery-plan.md` is a paused October 6 checkpoint and historical
evidence, not the current queue. Long donor playbooks are evidence, not an alternative work scheduler.

## 2. Cloudflare-first ownership is final

### Cloudflare owns commodity platform behavior

```text
AI Search hybrid BM25/vector retrieval, provider fusion, reranking and metadata filtering
AI Search Items upload/index status and managed search storage
Web Search / Markdown / Browser Run acquisition transport and crawl mechanics
Workflows durable safe-step retry/delay/timeout/sleep/waitForEvent
Queues redelivery, retry exhaustion, DLQ, concurrency and backlog metrics
AIChatAgent / WebSocketChatTransport presentation, message persistence and resumable streams
AI Gateway routing/platform controls
D1 / R2 / Durable Objects primitives
Workers/Agents traces and infrastructure telemetry
```

### Eliot implements only missing semantic authority

```text
canonical SourceRevision and exact EvidenceHandle
scope / tenant / owner / residency / purge / currentness authority
request / invocation / output / generation identities
source qualification and independence
coverage / omission / no-hit / scoped-absence semantics
root question, branch question and hypothesis identity
counter-search, falsification and contradiction candidates
claim audit and exact citation outcomes
research debt, unknowns, completion dispositions and reopen
versioned derived artifacts and publication authority
product plans and section-local evidence
unknown external-effect settlement
```

No custom vector database, keyword engine, reranker, crawler platform, workflow server, agent graph
runtime, WebSocket resume protocol, DLQ service or telemetry backend belongs in the required core.

## 3. Donor decision register is final

Every donor idea is classified in `BACKEND-IMPLEMENTATION-CARDS.md` as:

```text
PLATFORM              Cloudflare already owns the mechanism
ADOPT                 bring one invariant into an existing Eliot owner
ALREADY_STRONGER       Eliot already has the stronger authority contract
DEFER_UNTIL_MEASURED   implement only after workload/Golden evidence
REJECT_CORE            would create a duplicate runtime/store/registry or violate Worker boundaries
```

### Adopt now

```text
WeKnora best-rank-per-identity RRF                         → #242
Agentset bounded filter capability checks                 → #320/#242
LightRAG complete-or-raise inventory/cursor semantics     → #244
Onyx generation readiness and guarded promotion           → #244
Open Notebook extraction/error boundary                   → #231/#239
DocsGPT plan-before-render context selection               → #233
SurfSense ordinal citation aliases and source defanging   → #233/#261
SurfSense stable line/span provenance                      → #239/#240
WeKnora optimistic artifact revision invariants            → existing #246/#247 owners
Cognee non-destructive contradiction candidates            → #214
Graphiti temporal provenance fields                        → #249 after #248
Promptfoo result shape + BEIR metric definitions            → #285
Khoj unchanged-content reuse under generation ownership    → #244/#239
```

### Existing Eliot authority is already stronger

```text
SurfSense citation registry      → EvidenceHandle + AllowedReferenceManifest
WeKnora Wiki store                → Artifact COW + Wiki/publication owners
OpenViking context hierarchy      → SourceCard + DocumentMap + ProjectAtlas + artifact revisions
RAGFlow/Dify checkpoints          → Cloudflare Workflows + Eliot effect settlement
Onyx ACL choke point              → frozen scope + #320 prefilter + exact current resolver
GraphRAG table artifacts          → Artifact COW and immutable referenced objects
Haystack component runtime        → fixed versioned Research stages and schemas
```

Only test/UX/invariant details may be borrowed from these; no second owner is created.

### Deferred until measured

```text
PipesHub DRR/heavy-light scheduler   after #288 proves native Queue partition/concurrency insufficient
MaxKB multilingual query rewriting  after Golden multilingual/code/version recall gap
OpenViking tree traversal            after benchmark against managed hybrid + DocumentMap navigation
Graph/PPR reranking                  after exact relation overlay and Golden benefit
provider-neutral vector registry     after a second search provider is actually selected
Text Fragment links                  UI owner after exact EvidenceHandle resolution
local desktop SQLite patterns        only for a separately selected desktop product
```

### Rejected from core

```text
LangChain/LangGraph/Dify/RAGFlow/Haystack generic runtime
Neo4j/Arango/GraphRAG database
OpenViking filesystem namespace
custom crawler/browser farm
custom vector/BM25/rerank engine
second citation registry
second artifact/Wiki store
generic plugin/component marketplace
LLM summary/entity output as canonical source
delete-before-rebuild indexing
```

## 4. Starting PR set is completely classified

The audit started with 76 open PRs. Every one has an explicit disposition in
`FINAL-PR-DISPOSITION-MATRIX.md`.

Cleanup performed without merge:

```text
source-preserved/superseded: #121 #173 #174
absorbed criteria/profiles:  #212 #213 #215 #234 #235 #236 #237 #238
```

No branch was deleted and no historical branch was merged wholesale.

## 5. Concrete source/readiness blockers are bounded

```text
#320  current-main reconciled head 55b5fedef3f9c5b4d7cca9c490739e24d611e0c8
#321  current-main reconciled head fbef9fe3fcd28c434581206bd3c1bdd4f64f6a81
#322  bounded current-main lane-order source patch
#323  bounded current-main tuple-identity source patch
#328  bounded decoder repair head 96ff0f1a5766a2b400b5f237968bb63d1d088150
```

Repository-pinned compiler/lint/focused tests remain implementation gates.

## 6. First implementation wave

One worktree per manager; one bounded checkpoint per manager; one named integrator owns shared contracts,
composition, routes, migrations, manifests, barrels, lockfiles, generated bindings and CI.

```text
Manager A  #209
Manager B  #321 → #331
Manager C  #322 + #323
Manager D  #324 → #320 → handoff to #242 integrator
Manager E  #332
Manager F  #282
```

The manager launch template and reviewer checklist are in `backend-entrypoints.md` and the cards.

## 7. Non-circular core order

```text
#209
├─ #261 / #262 / #263 / #256
└─ shared failure vocabulary

#321 → #331
#322 + #323
#324 + #320 → #242
#332 independently
#282 independently

#242 + #209 → #325 → #214
#209 + #330 → #326 / #264
#209 + #242 + #325 → #233
#233 → #246 → #247 → #255

#209 → #231 → #239 → #240 → #241
                    └→ #244
#239 + #240 → #248
#240 + #247 + #248 → #249

#328 → #285
#282 → #268
```

Optional client profiles, optional Rust/Wasm promotion, UI replacement, staging and paid quality runs do
not block deterministic backend core unless the active PR names a concrete cross-owner dependency.

## 8. High-value duplicate removals are mandatory

Implementation is not complete unless it deletes/retires the old path after caller migration:

```text
vector-only managed Search + weak D1 phrase relevance + local double fusion
→ one scoped AI Search hybrid list + Eliot exact evidence/coverage

native Workflow steps + custom generic checkpoint engine for every stage
→ native safe-stage retry + Eliot ledger only for unknown effects

ResearchWorkflow + ResearchSession second 18-stage executor
→ ResearchWorkflow sole execution owner

manual external-task polling/recovery as normal wait
→ waitForEvent/sendEvent + authoritative D1 result

custom WebSocket resume/history
→ AIChatAgent/WebSocketChatTransport

Queue DLQ/retry + magic application attempt ceiling
→ Cloudflare terminal transport + Eliot business settlement

private complete-body readers
→ one bounded platform reader

head read + later unbounded event history
→ event frontier bound to the observed head

separate COMPARE/HYPOTHESIS/FACT_CHECK/AUDIT/DEEP runtimes
→ profiles of one product-plan compiler
```

A wrapper over two still-active engines is not consolidation.

## 9. Required implementation handoff fields

Every active implementation PR must report:

```text
old active owner/path
new single owner/path
migrated callers
removed/retired duplicate
legacy persisted codec/read path
Cloudflare primitive reused
Eliot semantic authority retained
net production LOC and emitted bundle delta
D1/R2/provider-call delta
negative/replay/lost-ACK/bound checks
remaining PENDING gates
```

## 10. Verification boundary

Completed during audit/preparation:

```text
GitHub permission/write capability check
source and PR ancestry/overlap review
Cloudflare official capability ownership review
pinned donor source review
preservation reconciliation
all-PR disposition matrix
bounded #328 source correction
non-forced #320/#321 current-main reconciliation
entry-point/router cleanup
implementation cards and donor decision register
P0/P1 passport rewrites with exact anti-duplication boundaries
```

Still implementation/release work:

```text
repository-pinned TypeScript/ESLint/Vitest
minimal Clippy for changed Rust crates
D1 expression-depth/target checks when SQL changes
Worker/owner-web emitted bundle checks
native Workflows/Queue/WebSocket/AI Search acceptance
provider/model quality and paid-effect qualification
staging/deployment/load/release evidence
```

Repository-local `node scripts/check-docs-index.mjs`, compiler, lint and tests were not executed in this
connector-only closure pass and remain `PENDING` before merge. GitHub file/ref readback was performed.

No production deployment, paid provider call, Cloudflare resource mutation, main merge, branch deletion,
backup operation or historical uncertain-run replay was performed.
