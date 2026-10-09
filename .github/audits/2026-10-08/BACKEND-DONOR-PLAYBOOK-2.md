# Backend donor playbook — round 2

Date: 2026-10-08. Backend only. Source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.

This continues `BACKEND-DONOR-PLAYBOOK.md`. It does not create a second delivery queue and does not implement runtime changes. The user-supplied registry `AI_knowledge_RAG_NotebookLM_Dify_landscape_2026-10-08.md` is an audited catalogue, not a common runtime benchmark. Frontend and interface documentation remain with the other agent.

## Start here

1. Read `docs/START-HERE.md`, the current backend checkpoint, root/package `AGENTS.md`, `docs/implementation/failure-model.md` and `docs/implementation/scoped-verification.md`.
2. Claim one existing PR only. Use one worktree per manager. Shared contracts/composition/migrations have one integrator.
3. Read the PR's original S/R passport before this supplement. Preserve its original acceptance and historical codecs.
4. Use current main, not the product tree of an old planning branch. A mergeable documentation PR is not implemented code.
5. Every implementation names: old owner, new single owner, migrated callers, deleted duplicate, compatibility boundary, scoped compiler/lint commands and still-pending native gates.

| PR | Donor section | Primary code owner |
|---|---|---|
| #231 R07/S39 web acquisition | B5 | native web-search adapter + existing raw capture/admission |
| #325 R03 native branches | B6 | shared branch query/finding envelope |
| #326 R05 external wait | B7 | native Workflow wait + authoritative external task store |
| #285 S93 quality gate | B8 | testkit evaluator/run manifest |
| #209 R00 first cause | B9 | failure vocabulary and citation-resolution outcomes |

<a id="b5"></a>
## B5 — #231: discovery, fetch, extraction and admission are four different states

### Donor code inspected

- [Open Notebook `open_notebook/graphs/source.py`](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/source.py): `_usable_engine`, `_extraction_error`, `content_process`, `save_source`, `trigger_transformations`. Take the single extraction boundary, explicit effective engine and safe user/operator error separation. Do **not** copy immediate `source.save() -> source.vectorize()` as an index lifecycle, and do not classify every network failure as permanently nonretryable merely because another library retries internally.
- [Onyx connector interfaces](https://github.com/onyx-dot-app/onyx/blob/f858083d6cbe37c4146834d379e39511260a9879/backend/onyx/connectors/interfaces.py): `LoadConnector`, `PollConnector`, `SlimConnector`, `CheckpointedConnector`, `Resolver`, `ConnectorFailure`, `NormalizationResult`. Take capability-specific contracts, typed per-item failure and versioned opaque checkpoint validation. Do not import the connector framework.
- [PipesHub `PublicUrlFetcher`](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/public_http.py): validate every redirect hop, cap bytes, preserve original Host/SNI while connecting to a validated address, disable environment proxies and stop address failover after any response. This is a security **invariant**, not TypeScript code to paste into Workers.

### Cloudflare boundary

Workers `fetch()` cannot fetch a literal IP URL, so PipesHub's IP-pinning implementation is not directly portable. Do not emulate it with unverified headers. The Eliot adapter must instead use the narrowest Cloudflare-native transport, manual redirect policy, strict public URL/host/scheme validation, no private VPC binding, bounded response reading and an explicit egress policy. Browser Run/crawl events are optional acquisition mechanisms, not authority. If a required DNS-rebinding guarantee cannot be proven with the chosen Cloudflare product, reject that route or place it behind a separately qualified egress service; do not claim parity with `PublicUrlFetcher`.

### Existing Eliot code to reuse

- `packages/cloudflare-raw-ingest/src/raw-capture-owner-service.ts`: `createRawCaptureService`, current owner/purge/currentness checks, immutable R2 store.
- Existing raw/normalized admission: `createRawNormalizedAdmissionService`, `ownerPort`, `readRawMarkdownCandidate`, bundle prepare/upload/complete/commit/status/recovery.
- Existing markdown conversion and exact evidence pipeline.
- Cloudflare native websearch transport selected in #231; no provider SDK fan-out.

### CODE — ordered changes

1. Add one small discovery adapter. Its result is `DISCOVERED_LOCATOR`, never a SourceRevision or EvidenceHandle. Preserve `raw_user_query`, `submitted_query`, `provider_observed_query` when actually returned, provider/request identifiers when observed, and per-item omission reasons. Malformed rows are not silently dropped.
2. Define a minimal versioned acquisition outcome, not a generic connector platform:

```text
AcquisitionCandidate
  candidate_id
  requested_url
  observed_url?
  title/snippet?            # hints only
  provider_locator
  discovery_receipt_ref
  state: DISCOVERED | FETCHED | EXTRACTED | ADMITTED | REJECTED | UNKNOWN

AcquisitionFailure
  phase: DISCOVERY | FETCH | EXTRACT | ADMISSION
  class: INVALID | DENIED | NOT_FOUND | UNSUPPORTED | TRANSIENT_IO | CORRUPT | EFFECT_UNKNOWN
  retryable
  effect_may_have_happened
```

Do not add a new source store, scheduler or citation registry.
3. Before network I/O, validate operation policy, corpus-only mode, cancellation, query/result bounds and permitted transport. Empty/denied scope performs zero provider calls.
4. Discovery snippet is never admitted as document text. A selected locator goes through controlled fetch/capture. Validate every redirect hop at the application's observable boundary; reject credentials in URLs, non-http(s), blocked hosts, private-network routes, excess redirects, oversize, unsupported content type and login/captcha/partial pages. Preserve final observed URL and redirect chain digest without leaking secrets.
5. Store raw bytes first through existing raw capture. Extraction is a separate, idempotent stage bound to raw digest, extractor/parser fingerprint and output digest. Empty source, extraction failure and unavailable optional engine are distinct outcomes. A safe fallback engine is explicit in the receipt; it is not silent success under the requested engine name.
6. Admission rechecks current ownership/scope/purge and produces SourceRevision only after bytes and normalized output pass existing validation. Optional transformations/enrichment run after canonical searchability and cannot turn malformed AI output into canonical source text.
7. For future connectors, use Onyx's capability split as the contract shape: full load, incremental poll, slim enumeration, permission sync, checkpointed load, resolver. One bad item yields typed item failure; checkpoint advances only according to the connector's documented consumed-item rule. Do not implement this entire family inside #231.
8. Unknown dispatch outcome does not authorize another paid websearch. Exact provider readback is used only where the native API exposes an immutable locator. Otherwise retain `EFFECT_UNKNOWN` and let the operation owner decide.

### Result and acceptance

A URL becomes evidence only through discovery -> controlled capture -> typed extraction -> current admission -> exact retrieval. Search results, redirects and parser output remain inspectable. There is no parallel source/index pipeline.

Acceptance: corpus-only zero calls; malformed provider row retained as omission; redirect to disallowed target rejected; parser differential/credential URL; oversize with and without Content-Length; optional engine missing; empty content; lost discovery/fetch ACK; duplicate callback; one bad connector item with later valid item; stale owner/purge before admission; post-freeze source requires reopen. Never log raw credentials or provider bodies.

<a id="b6"></a>
## B6 — #325: branch-local search produces findings, not just selected handles

### Donor code inspected

- [Open Notebook `ask.py`](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/ask.py): strategy -> per-query retrieval/partial answers -> synthesis; scope forwarded to every leg; blank terms and empty partial/final outputs handled explicitly. Do **not** copy vector-only top-10, free prose partial answers, mutable payload or the unenforced prose claim “up to five” without a schema bound.
- [RAGFlow `tool_search_chunks.go`](https://github.com/infiniflow/ragflow/blob/ef150bc2cd2c4b6ccb6be72014e1d8bc382bff6c/internal/agentic_rag/tool_search_chunks.go): 1-5 short focused queries, explicit dataset/doc scope, bounded top-N, triage snippets separated from authoritative `list_chunks` deep read. Do not give the model unrestricted fusion weights/extreme retries or treat XML snippets as evidence.
- PaperQA2 `GatherEvidence`: bind each context to the question that requested it; do not mutate a global `session.question` and do not import its runtime.

### Confirmed Eliot gap

`ResearchBranchRoleModelOutputSchema` contains role/status/handle refs/unknowns/limitations but no substantive finding or relation to a named question/hypothesis. `research-synthesis-prompt.ts` compiles the frozen EvidencePack plus root question; it does not pass meaningful branch findings to synthesis. Therefore a paid branch call can select handles without contributing its analysis to the final answer.

### Existing code to reuse

- Planning manifest question and hypothesis records.
- `retrieveWithHeldScope` after #242 and exact evidence resolver.
- `buildRoleResultFromModelOutput`, `branchResult`, `debtFor`, existing checkpoint/freeze/audit.
- `createResearchModelPromptCompiler` and current model-attempt ledger.

### CODE — ordered changes

1. Introduce one versioned `BranchQueryPlan` owned by #325:

```text
branch_id / role
root_question_ref+digest
question_id / exact question text+digest
hypothesis_refs[]
retrieval_product
focused_queries[]          # bounded server-validated
literal_probes[]
candidate/scan/evidence/byte budgets
required/optional
stop_rule
plan_generation
```

The model may propose queries, but the server validates count, length, scope, duplicates and budget. The branch question is immutable and enters request/model identity.
2. A simple question/branch has a direct path; do not always fan out. When multiple focused queries are justified, execute boundedly and retain per-query trace/omissions. Do not infer absence from a no-hit.
3. Separate triage locator from authoritative evidence. Search may return snippet/score for selection; exact handles are resolved before model analysis. RAGFlow's `list_chunks` lesson maps to Eliot's existing resolver — do not add another deep-read API.
4. Replace handles-only output with a compact `BranchFindingCandidate`:

```text
finding_ref
branch_id / question_id
kind: SUPPORT | QUALIFY | CONTRADICT | ALTERNATIVE | CHRONOLOGY | IMPLEMENTATION_GAP | SOURCE_RISK
statement
conditions_and_scope
handle_refs[]
unknowns[]
limitations[]
status: CANDIDATE | BLOCKED
```

The statement is model-produced candidate text, not authority. Every cited handle is server-issued and current; foreign aliases fail closed. Required findings without evidence are blocked/debt, not empty success.
5. Keep one builder. Evolve `ResearchBranchRoleModelOutputSchema` and `buildRoleResultFromModelOutput`; do not create a second result hierarchy beside `ResearchBranchResult`. Store exact branch query/result digests and model receipt.
6. Pass branch findings, failures, omissions and debts into synthesis as server-serialized data bound to the same freeze/question/plan. Do not pass only a count or assume the model remembers earlier calls. Synthesis cites original EvidenceHandles, not finding text as evidence.
7. Bounded parallelism preserves completed branch outputs when a sibling fails. One branch's failure does not roll back another branch's admitted evidence. COUNTER remains #214's specialized relation stage after shared types land.
8. Remove `evidenceForRole` substring routing only after all roles use query/selection provenance. Source-class metadata is a signal, never role authority.

### Result and acceptance

Each required branch has its own immutable question, retrieval receipt, exact evidence and substantive candidate findings that reach synthesis. Model calls are skipped for nonexistent/optional-unneeded roles.

Acceptance: two roles with same evidence but different questions produce distinct inputs; blank/duplicate/oversized proposed queries; direct path; focused multi-query cap; snippet cannot be cited before exact resolve; branch partial success; finding reaches synthesis; forged handle/alias; old run schema rejected or read by explicit legacy codec; no counter auto-classification; completed paid attempt not repeated.

<a id="b7"></a>
## B7 — #326: native durable wait, stable topology and exact result consumption

### Donor code inspected

- [RAGFlow `canvas/compile.go`](https://github.com/infiniflow/ragflow/blob/ef150bc2cd2c4b6ccb6be72014e1d8bc382bff6c/internal/agent/canvas/compile.go): minimal checkpoint store/serializer interfaces, stable checkpoint ID, compile-time rejection of incompatible interrupt topology, terminal-node and duplicate-interrupt guards.
- RAGFlow crash/resume tests: completed nodes and loop sub-state must not rerun after process restart. Use the test pattern, not the Go runtime.
- [Dify `pause_state_persist_layer.py`](https://github.com/langgenius/dify/blob/2b65f0e8930964ce2be9e7054dde5a2cd74ff605/api/core/app/layers/pause_state_persist_layer.py): versioned discriminated resumption context and persistence of the exact stream-filter instance that observed emitted output. Apply stream-cursor state only if Eliot has a resumable progress stream; do not add it to a locator-only event.
- LightRAG resume/flush contracts: persisted executable parameters are revalidated on resume; failure records whether durable references can have been lost. Take the outcome semantics, not its storage framework.

### Confirmed current behavior

`research-external-branch-analysis.ts:executeOrRecover` reads an existing result, publishes the task, immediately reads once again, and returns `WORKFLOW_EFFECT_UNCERTAIN` when no result is already present. Normal waiting is therefore implemented as uncertain failure + recovery, not a durable wait.

### Existing code to reuse

- Cloudflare Workflows `step.waitForEvent` / instance `sendEvent`.
- `ExternalAgentTaskStore`, task payload store, grant/lease/currentness, existing D1 outbox and `consumeResult` exact checks.
- Existing W2 request/attempt/result identity and compatible manual recover API.

### CODE — ordered changes

1. Introduce a new handler generation/topology. Historical runs keep their old topology and recovery behavior. A stable step/event identity is derived from operation/stage/attempt/request digest; retry does not mint a random ID.
2. Publish task intent/payload and exact authoritative task row before waiting. Then native `waitForEvent` waits for a small locator event:

```text
ExternalTaskWakeEvent
  protocol/version
  task_id
  operation_id
  stage_index
  attempt_ref
  request_sha256
  result_digest
```

No full result, evidence text, provider output or secret crosses the event.
3. The callback commits the authoritative result first, performs exact readback, records an outbox intent, then sends the event. Lost/duplicate send ACK is safe: same locator may be resent; consumption is idempotent. An event without a committed matching result is rejected/ignored, never success.
4. After wake, re-read task/result/grant/scope and use existing `consumeResult`. Event payload is a hint plus digest, not authority. Early events, duplicate events and late events are bound to the exact attempt.
5. Timeout is a visible wait timeout, not proof the agent failed or no result exists. Perform exact readback once; committed matching result can complete, absent result stays waiting/timeout according to versioned policy, conflicting result fails closed.
6. Revalidate persisted executable fields at resume: event type, task kind, stage, deadline, handler generation, allowed operations and bounds. Old malicious/oversized values cannot auto-resume merely because they passed an older decoder.
7. Native Workflow handles waiting. Keep Eliot's attempt ledger only for the external business effect/result and unknown dispatch boundary; do not wrap waitForEvent in another polling/restart engine.
8. If progress/output streaming is resumable, persist an explicit last-emitted sequence/cursor from the same emitter that produced client events, following Dify's lesson. If the event is locator-only and no stream is replayed, do not add stream-filter state.

### Result and acceptance

A normal external task pauses durably and resumes after a committed result. Restart does not re-publish a completed logical task or rerun completed prior stages.

Acceptance: event before wait; duplicate/late/foreign event; result commit before lost event ACK; event sent before durable result rejected; Workflow restart; timeout with result arriving at boundary; revoked/cancelled grant; stale handler generation; malformed persisted event type; completed predecessor nodes not rerun; progress chunks not repeated when that feature is enabled. Unknown provider dispatch remains unknown.

<a id="b8"></a>
## B8 — #285: deterministic hard gates first, retrieval metrics second, judges last

### Donor code inspected

- [Promptfoo `GradingResult`](https://github.com/promptfoo/promptfoo/blob/e3a19c8f8d71f322526e87f56d34d47cca6d1406/src/types/index.ts): `pass`, `score`, `reason`, `namedScores`, token usage and component results. Take structured per-assertion outcomes. Do not make Promptfoo, arbitrary JS assertions or user-overridden grades canonical authority.
- [BEIR `EvaluateRetrieval.evaluate`](https://github.com/beir-cellar/beir/blob/ef83d29307061c65d04b035b4f4e7c18bd8374af/beir/retrieval/evaluation.py): standard qrels-based NDCG/MAP/Recall/Precision and custom MRR. Take metric definitions/fixture shape. Do not mutate Eliot's stored result map while removing identical IDs, and do not use ranked metrics when relevance labels are merely binary/ungraded.
- Existing ScholarQABench/DeepResearchGym analysis remains secondary: citation correctness and answer quality are separate; bounded judge calls retain individual outcomes. LLM judge is not ground truth.

### Existing code to reuse

- `packages/testkit/src/golden.ts` and #328's unknown/failure changes.
- Existing Golden corpus, EvidenceHandles, ClaimAudit, retrieval traces and exact receipts.
- Existing model/provider cost and attempt receipts; no second observability store is required for the gate.

### CODE — ordered changes

1. First close evaluator completeness: promotion receives an immutable expected-case manifest. Results must match exactly one-to-one — no missing, duplicate or foreign case IDs. Empty run never passes. Validate all observation containers/cardinality before iteration.
2. Version Golden v2 separately from v1. Bind `expected_query_product`, `expected_execution_product`, partition, required atoms/handles, forbidden collapses, canonical acceptable-unknown IDs, coverage/source-family requirements and optional performance budgets. Do not infer products for old fixtures.
3. Define a versioned run manifest before execution: code SHA, corpus/case digests, product-plan/retrieval/index/parser/chunker/prompt/schema/model route generations, scope profile, cache mode and environment identity. Results without exact manifest identity cannot be compared or promoted.
4. Per case, keep component outcomes instead of only aggregate score:

```text
EvaluationAssertion
  assertion_id
  class: HARD | METRIC | JUDGE | OPERATIONAL
  pass
  score?
  reason_code
  observed_refs/digests
  evaluator_fingerprint
  cost/tokens/latency?
```

Hard failures — foreign evidence, unresolved citation, forbidden collapse, unexpected unknown, incomplete expected set, authority leak — block promotion regardless of averages.
5. Retrieval qrels use exact source/chunk/handle identity. Compute Recall@k, MRR and NDCG only where labels support them; store per-query values and macro aggregate. Keep lexical/vector/provider/final ranks and omissions for diagnosis. Do not modify production result bytes to fit a metric library.
6. Answer/artifact evaluation remains separate: required-atom recall, claim-support precision/coverage, exact citation resolution/alignment, abstention/unknown correctness, counterevidence handling and completion disposition.
7. Operational metrics remain separate: provider/model calls, tokens, D1/R2 work, latency, cost per successful deliverable and unknown external effects. Cold/warm runs are not averaged together.
8. Development cases may tune thresholds. Holdout is frozen before evaluation and never auto-tuned. LLM/human judges produce named secondary assertions with model/prompt identity and variance; they cannot erase deterministic failure.

### Result and acceptance

Promotion is reproducible from an immutable case/run manifest and exact per-assertion results. One aggregate number cannot hide a security or evidence failure.

Acceptance: empty results; duplicate/foreign/missing case; malformed container; v1 compatibility; binary versus graded qrels; zero-hit query; same output under different generation rejected as incomparable; cold/warm separation; hard fail plus high mean; judge disagreement retained; threshold changed after holdout invalidates promotion identity.

<a id="b9"></a>
## B9 — #209: first cause and effect settlement use explicit outcome dimensions

### Donor code inspected

- Open Notebook `_extraction_error`: internal typed cause is separated from bounded user message. Do not copy its blanket decision that every library error is permanent.
- LightRAG storage flush contract: on failure state whether committed references may be gone/unknown. This is the useful invariant for Eliot settlement; do not import its storage APIs.
- Existing Eliot Markdown adapter already distinguishes NOT_STARTED / OUTCOME_UNKNOWN / RESPONSE_RECEIVED. Reuse the vocabulary shape rather than creating another generic error framework.

### CODE — ordered changes

1. Keep R00's existing forward SQL/TypeScript vocabulary work. Add no new status unless every D1 guard, codec, status reader and migration agrees.
2. Citation resolution records a per-handle typed outcome:

```text
RESOLVED
INVALID_REFERENCE
AUTHORITY_REVOKED
SOURCE_QUARANTINED
CONTENT_MISMATCH
VERIFY_UNAVAILABLE
STORAGE_UNAVAILABLE
EFFECT_UNKNOWN
```

Only proven invalid/revoked/mismatch belongs in rejected evidence. Unavailable/unknown aborts or degrades according to protocol; it does not rewrite the source as invalid.
3. Preserve orthogonal dimensions internally: phase, safe code, retryability, dispatch/effect state, whether durable references remain intact, recovery action, first-cause link. Public status remains bounded and sanitized.
4. First failure is immutable. Later budget/cancel/cleanup/recovery failures link as consequences and cannot replace it. Unknown error codes remain unknown and gain no authority.
5. Store/read errors preserve typed domain failures; only unknown transport is mapped to settlement uncertainty. Message matching is not trusted classification.
6. Lost ACK recovery uses exact immutable IDs/digests. A retryable readback failure does not become permanent conflict or proof that no effect occurred.

### Result and acceptance

Status tells the operator whether the source/evidence is invalid, authority was revoked, verification was unavailable or an external effect may already have happened — without raw provider text/secrets.

Acceptance: every freeze code survives SQL/status; invalid versus unavailable; lost ACK; first failure plus later budget stop; durable reference intact/unknown; unknown code; legacy receipt; public redaction; no automatic paid retry.

## Coordination order

```text
#209 failure vocabulary
#324 response envelope + #320 bounded filter
#242 retrieval identity/ranking
#325 branch query/finding envelope
#214 counter specialization
#326 external wait can proceed independently except shared failure codes
#233 ASK/BRIEF consumes #242/#325
#285 evaluates assembled outputs; its deterministic expected-set work can proceed now
#231 acquisition is separate; admitted outputs later feed #244/indexing and #242
```

Do not mix these owners in one giant PR. The goal is fewer runtime paths, not fewer review boundaries.
