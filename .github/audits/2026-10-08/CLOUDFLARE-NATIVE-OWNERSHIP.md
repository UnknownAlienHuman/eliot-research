# Cloudflare-native ownership and backend audit completion gate

Date: 2026-10-08  
Eliot source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`  
Scope: backend. UI and interface documentation are owned by the other agent.

This document answers one question before any new backend code is approved:

> Is the proposed function already provided by Cloudflare, and if so, what domain guarantee remains Eliot-specific?

It is a supplement to the R00–R08 PR passports. It does not create another implementation queue.

## 1. Product boundary

Eliot is not another generic RAG framework or workflow engine. It is a source-grounded research and distillation system for humans and agents.

Cloudflare should own commodity infrastructure:

```text
fetch / render / convert
managed hybrid retrieval
model and search transport
workflow durability / retries / waits
queue delivery / retry / DLQ
session WebSocket transport / resumable streams
D1 / R2 / Durable Object persistence primitives
provider routing, billing and operational telemetry
```

Eliot must own the semantics Cloudflare does not provide:

```text
canonical SourceRevision
exact EvidenceHandle
scope / tenant / owner / purge authority
source qualification and source-family independence
query, invocation and output identity
coverage / omission / absence semantics
root-question and branch-question binding
counter-search and falsification
claim audit and exact citation disposition
research debt and explicit uncertainty
versioned derived artifacts and publication authority
unknown external-effect settlement
product plans: ASK / BRIEF / RESEARCH / FACT_CHECK / ...
```

## 2. Platform allocation matrix

| Capability | Cloudflare owner | Eliot adapter / remaining responsibility | Do not build |
|---|---|---|---|
| Hybrid relevance | AI Search | compile authorized scope; preserve provider query/ranking; diversify; exact resolve; coverage | second vector DB, second generic BM25 engine, second provider RRF |
| Embeddings/reranking used by AI Search | AI Search / Workers AI | generation identity and quality qualification | application-side duplicate embedding/rerank call for the same managed leg |
| Search provider transport | Web Search API through AI Gateway | bounded discovery receipt; candidate/admission separation; exact capture | Ceramic/Exa/Linkup SDK fan-out |
| Website Markdown | Markdown for Agents, `AI.toMarkdown`, Browser Run `/markdown` | canonical raw capture, parser fingerprint, normalized candidate and admission | custom general HTML crawler/parser as default |
| Rendered page capture | Browser Run `/snapshot` | egress policy; raw/screenshot/accessibility artifacts; admission | own headless-browser farm |
| Website crawl | Browser Run `/crawl` + Queue lifecycle events | bounded crawl plan, source admission, authority and cost policy | polling crawler scheduler |
| Durable workflow | Workflows `step.do`, retries, timeout, sleep | effect classification; authority; domain receipts; unknown effects | second generic workflow/checkpoint engine |
| External wait | Workflows `waitForEvent` / `sendEvent` | authoritative result in D1; event locator; exact readback | polling/manual recovery as normal wait path |
| Queue delivery | Queues `ack/retry`, configured retry delay, max retries and DLQ | D1 outbox atomic intent; inbox lease/idempotent business effect; exact settlement | second generic delivery retry/DLQ scheduler |
| Chat/session transport | `AIChatAgent`, `WebSocketChatTransport`, resumable streams and typed data parts | authenticate; bind conversation to project/run; read canonical D1/R2/Workflow state | custom WebSocket resume protocol and stream-buffer database |
| Provider/model routing | AI Gateway | server-owned route generation; budget/profile identity; selected provider/model receipt | provider-specific hot-path routing framework |
| SQL storage | D1 | schemas, CAS predicates, exact readback, source/authority constraints | ORM/service layer that hides settlement semantics |
| Read-heavy sequential reads | D1 Sessions | use only where sequential consistency is sufficient; bookmarks are not permissions | custom replica router; use of Sessions as fake transaction |
| Immutable/object storage | R2 | conditional immutable keys, digest, residency, erasure closure | second blob store |
| Connected state | Durable Objects / SQLite | compact presentation state and per-session coordination | canonical evidence or research truth in DO-only state |
| Infrastructure traces | Workers Traces / Analytics Engine | redact payloads; attach safe generation/operation IDs; product quality receipts | custom distributed tracing backend |
| Long-term analytical data | Basin / Pipelines where qualified | export non-authoritative quality/cost events | operational authority or current ACL in analytical store |

## 3. Current reuse already done correctly

The following existing choices should be preserved:

1. `packages/cloudflare-markdown` already calls `AI.toMarkdown`; Eliot adds bounded input/output, attempt semantics and admission rather than reimplementing document conversion.
2. AI Search has an existing binding and instance profile; R02/#242 should use one managed hybrid ranked list instead of rebuilding its keyword/vector fusion.
3. D1 outbox remains necessary because Queue send cannot be atomically committed with a canonical D1 mutation. Queue begins after the D1 transaction, not inside it.
4. Exact EvidenceHandle resolution remains necessary because provider results are locators and ranking signals, not proof or authorization.
5. AI Gateway request policy already suppresses prompt/evidence payload logging and records provider/model response identity; the remaining work is composite qualification, not a new gateway.
6. Workers observability is enabled. Product-quality metrics must be built on top of safe traces/receipts, not replace platform telemetry.

## 4. Confirmed duplicate or overbuilt paths

### 4.1 Retrieval

Current main configures managed keyword/vector/rerank capability but executes the managed leg as vector-only, then runs a weak D1 lexical leg and another local fusion. R02/#242 owns consolidation.

Remove or narrow:

```text
vector-only managed call as primary relevance
phrase-only D1 LEX as general lexical engine
document-head fallback mislabeled LEX
second vote for provider-internal keyword/vector signals
duplicate governed lane loops
```

Retain:

```text
IDENT / EXACT / literal / exhaustive D1 paths
authorized scope compiler
exact resolver
source diversity and omissions
```

### 4.2 Workflow execution

Current main runs all stages inside native `step.do` with retries disabled, then wraps every stage in the custom W2 executor. `ResearchSession` also has a second 18-stage execution path.

R08/#330 owns effect classes and the single execution owner:

```text
PURE_COMPUTE
AUTHORIZED_READ
IDEMPOTENT_WRITE
EXTERNAL_UNKNOWN_EFFECT
HUMAN_OR_AGENT_WAIT
```

Cloudflare Workflows becomes the only generic durable workflow runtime. Eliot's full attempt ledger remains only at the business-effect boundaries that need it.

### 4.3 External wait

Current external branch handler publishes a task, reads once, and returns uncertainty if the result is not already present. R05/#326 replaces normal failure/recovery with `waitForEvent`, while D1 remains result authority.

### 4.4 Session transport

`ResearchSession` declares WebSocket support in architecture, but current `/status` upgrade returns `SESSION_WEBSOCKET_PENDING`. Session state, reconnect, stream buffering and replay should not be implemented from scratch.

S72/#264 must first qualify `AIChatAgent` / framework-neutral `WebSocketChatTransport`. Canonical run/evidence state remains in D1/R2/Workflow.

### 4.5 Queue retry and terminal delivery

Cloudflare Queues already owns delivery attempts, configured retry delay, `max_retries` and DLQ. Eliot's D1 inbox is needed for leases, duplicate suppression and business settlement, but must not become an independent terminal delivery scheduler.

S64/#256 owns this simplification.

### 4.6 Web acquisition

Cloudflare Web Search, Markdown for Agents, `AI.toMarkdown`, Browser Run snapshot/crawl already provide discovery/render/conversion transport. Eliot adds controlled capture, extractor identity, source admission and exact evidence. R07/#231 owns this boundary.

## 5. Platform-specific rules for implementation agents

### Rule A — native capability first

Before adding a package/service, the PR must name the Cloudflare product and exact missing guarantee. If the guarantee is transport, retry, rendering, hybrid search, session streaming or storage, a new framework is presumed rejected until proven necessary.

### Rule B — no authority transfer to managed provider

A managed provider may return:

```text
rank
score
snippet
locator
provider query
processing metadata
```

It does not decide:

```text
access
source currentness
canonical identity
claim support
coverage completeness
publication
```

### Rule C — one durable owner

For each logical operation, document exactly one owner of:

```text
execution
business result
canonical storage
retry policy
completion decision
```

Cloudflare can own execution/retry while Eliot owns business result and completion semantics. Two generic owners are prohibited.

### Rule D — historical compatibility is explicit

Old handler generation, request codec, object manifest or session protocol is read through an explicit compatibility path. New code does not infer new semantics from old rows.

### Rule E — code reduction must be demonstrated

Each implementation reports:

```text
old path
new owner
migrated callers
removed duplicate
retained compatibility code
net production LOC
Worker bundle delta
D1/R2/provider call delta
```

Moving code to another package or adding a wrapper around both paths is not reduction.

## 6. PR ownership map after Cloudflare review

| Priority | PR | Backend result | Cloudflare primitive reused | Eliot-specific result |
|---|---|---|---|---|
| P0 | #209 R00 | first cause and typed outcomes | platform failures remain transport facts | evidence/failure semantics and exact effect state |
| P0 | #324 R01 | AI Search envelope compatibility | documented Search response | strict decoder and authority invariants |
| P0 | #320 | scope prefilter before top-k | AI Search filters | frozen scope and exact post-check |
| P0 | #242 R02 | one managed relevance path | AI Search hybrid/rerank | identity, diversity, exact evidence, coverage |
| P0 | #325 R03 | branch-local retrieval/findings | managed search/model transport | question binding, finding candidates, debts |
| P0 | #214 R04 | counter-search | managed retrieval/model | falsification and verified contradiction semantics |
| P0 | #233 R06 | ASK/BRIEF | existing Workflow/retrieval/model transport | product plan and verified artifacts |
| P0 | #330 R08 | effect classes / one workflow owner | Workflows retry/timeout/wait | business-effect settlement and authority |
| P0 | #285/#328 | deterministic quality gates | test execution primitives | evidence/coverage/product promotion criteria |
| P1 | #326 R05 | native external wait | Workflows events | authoritative external result/readback |
| P1 | #231 R07 | web acquisition | Web Search + Markdown/Browser Run | capture/admission/provenance |
| P1 | #244 S52 | Items reconciliation | AI Search Items | desired manifest, generations and qualification |
| P1 | #264 S72 | session streaming | AIChatAgent/WebSocketChatTransport | authentication and canonical run binding |
| P1 | #256 S64 | delivery recovery | Queues retry/DLQ | atomic intent, idempotent handler settlement |
| P1 | #291 S99 | large-scope truthfulness | AI Search/D1 read primitives | frozen-scope/candidate/coverage accounting |

## 7. Completion gate for audit and implementation preparation

The audit/preparation phase is complete only when every item below is true.

### 7.1 Repository coverage

- [ ] Every production backend package and application entry point has an owner/status classification.
- [ ] Every open backend PR has been read against current main, not merely its description.
- [ ] Closed/unmerged implementation branches have been classified as delivered, superseded or absent.
- [ ] No P0/P1 issue exists only as prose in the accumulated audit; it has an implementation passport or bounded source PR.

### 7.2 Cloudflare allocation

- [ ] Retrieval, workflow, queue, session transport, acquisition, conversion, model routing, storage and observability each have one Cloudflare-vs-Eliot owner decision.
- [ ] Every proposed new service/framework has a written reason why Cloudflare cannot provide the required primitive.
- [ ] Duplicate generic runtime paths have an explicit removal/migration plan.

### 7.3 Implementation readiness

Every P0/P1 passport contains:

- [ ] exact CODE files/functions;
- [ ] required documentation sections;
- [ ] dependencies and integration order;
- [ ] donor functions and immutable links;
- [ ] what to copy, adapt and reject;
- [ ] result contract;
- [ ] negative acceptance and failure injection;
- [ ] historical compatibility;
- [ ] scoped typecheck/lint/test commands;
- [ ] native/paid checks still marked PENDING;
- [ ] a single owner for shared contracts/migrations/composition.

### 7.4 Source PR readiness

- [ ] Actual source PRs are rebased or reconciled to current main.
- [ ] Draft status correctly reflects unexecuted compiler/native gates.
- [ ] No source PR silently overlaps another owner's files or semantics.
- [ ] The integration sequence can be executed without circular blockers.

### 7.5 Final handoff

- [ ] One concise backend execution index replaces the need to read the full accumulated audit.
- [ ] A final status table says `READY`, `BLOCKED`, `SUPERSEDED` or `OPTIONAL` for every backend slice.
- [ ] Remaining uncertainty is limited to runtime qualification/benchmarking that cannot be proven statically.

Only after this gate is satisfied should the audit be announced as complete.

## 8. Current status on 2026-10-08

**Audit and preparation are not complete yet.** The donor catalog and core Research path are substantially covered, but five closure blocks remain:

1. **S72/#264 — session transport:** qualify AIChatAgent/WebSocketChatTransport, remove new-run execution from ResearchSession and retain historical compatibility.
2. **S64/#256 — Queue:** remove independent terminal/retry ownership while preserving outbox/inbox business settlement.
3. **Cloudflare ownership closure:** apply this matrix to remaining backend PRs and current main entry points.
4. **Old PR/source reconciliation:** verify source PR #320–#323/#328 and all remaining old backend PRs against current main; record overlaps/conflicts.
5. **Final implementation graph:** produce one non-circular integration order and final `READY/BLOCKED/SUPERSEDED/OPTIONAL` table.

A sixth optional performance pass — D1 Sessions/read replicas and sampled observability — follows correctness classification. It is not allowed to block P0 correctness unless measurements prove it necessary.

## 9. What is deliberately not part of backend completion

- frontend visual design;
- interface copy and layout documentation;
- live deployment;
- paid provider benchmark runs;
- production migration execution;
- backup/offsite work currently stopped by owner;
- optional GraphRAG/memory layer beyond the explicitly approved product plan.
