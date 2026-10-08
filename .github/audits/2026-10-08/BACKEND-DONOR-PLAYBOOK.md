# Backend donor playbook — 2026-10-08

Scope: backend only. This supplements existing PR passports; it is not another execution queue and does not implement their runtime changes. Frontend code, interface documentation and UI tasks belong to the other agent.

Eliot source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.
User-supplied registry: `AI_knowledge_RAG_NotebookLM_Dify_landscape_2026-10-08.md`, SHA-256 `d5da24be9b6167301a475e40652866943d43d7679d0ed099515e8a4dfa4c08be`. It is a source-code/documentation catalogue, NOT a common runtime benchmark. Its TAKE labels are inputs to this review, not permission to replace Eliot architecture.

## Start — read this instead of the entire accumulated audit

1. Read `docs/START-HERE.md`, the current checkpoint of `docs/implementation/backend-delivery-plan.md`, and root `AGENTS.md`. The owner's present instruction authorizes backend audit/PR preparation, not deployment, destructive cleanup or backup. Do not create issue/discussion comments.
2. Select ONE existing PR from the table below and read its original passport. Preserve its original S acceptance; this document narrows the implementation method, not the promised outcome.
3. Read only the owning packet, its named architecture sections, `docs/implementation/failure-model.md`, `docs/implementation/scoped-verification.md`, and affected contracts/callers.
4. Inspect current main and the PR's actual diff. A documentation branch, an exported interface and mergeable=true are not an implementation. Reconcile a changed baseline before writing.
5. One manager uses one worktree if a checkout is used. Shared contracts, migrations, package exports and composition have one integrator. Do not create extra task worktrees or overwrite another agent's edits. Existing documentation PR branches are not a reason to merge their historical product tree.

| PR | Read first | Existing entry points | This document |
|---|---|---|---|
| #242 R02/S50 | ER-04; architecture §§6.5–6.9; R02-managed-retrieval.md; REPLAY-IDENTITY-AUDIT.md C13–C16 | createRetrievalQueryService, retrieveWithHeldScope, reciprocalRankFuse | B1 |
| #244 S52 | ER-38; architecture §§6.4.2/19.10; S52-items-reconciliation.md | createProjectionExecutionDeliveryHandler, createManagedProjectionPort | B2 |
| #233 R06/S41 | S41-ask-brief-product-runtime.md; architecture §7.12; affected prompt/manifest contracts | createResearchModelPromptCompiler, createEvidenceContextCompiler, createArtifactCowSectionProducer | B3 |
| #214 R04/S22 | R04-counter-search.md; architecture §§7.2/7.8–7.9; #325 shared branch envelope | buildRoleResultFromModelOutput, evidenceForRole, existing freeze/claim audit | B4 |

The original passports remain linked from these PR bodies. #320/#324 own the existing managed filter/envelope prerequisite; #325 owns shared branch types before #214. No new frontend contract is silently assigned to the interface agent.

## Native platform before donor code

Use Cloudflare for the work it already provides. Use donor code to identify missing invariants, not to bring its deployment into the Worker.

| Need | Reuse | Eliot still owns |
|---|---|---|
| Keyword/vector/hybrid retrieval and reranking | existing AI Search binding/adapter | authorized scope, exact evidence, query/execution identity, honest coverage |
| Atomic D1 changes | D1 batch or existing atomic command/trigger path | CAS predicates, operation identity, expected-set checks and readback |
| Upload/index/status/readback | Items uploadAndPoll/get().info()/get().download() | per-item intent/receipts, generations, purge/owner fences |
| Queue delivery/backoff | message ack/retry, consumer bounds, existing D1 outbox | canonical intent, dispatch ownership, uncertain effects |
| Durable wait/replay | Workflow step.do/waitForEvent/sendEvent via existing R05 | business task result, evidence authority, no duplicate unknown paid effect |

Official docs checked in this pass: [AI Search binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/ai-search/), [reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/), [filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/), [Items](https://developers.cloudflare.com/ai-search/api/items/workers-binding/), [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [Queue acknowledgement/retry](https://developers.cloudflare.com/queues/configuration/batching-retries/), [Workflow events](https://developers.cloudflare.com/workflows/build/events-and-parameters/). Search/rerank/Items pages identify the October 1, 2026 API generation. Pin installed SDK signatures before implementation; documentation is not proof that an undeclared binding method is available locally.

<a id="b1"></a>
## B1 — #242: one retrieval implementation, one vote per result list

### Donor code actually inspected

- [WeKnora knowledgebase_search_fusion.go](https://github.com/Tencent/WeKnora/blob/005627b180c6c7509660b0a14401e463f48d53f8/internal/application/service/knowledgebase_search_fusion.go): `classifyRetrievalResults`, `deduplicateByScore`, `bestRanks`, `fuseWithRRF`. Keep result-list boundaries; duplicate chunk occurrences do not create additional votes. Do NOT copy candidate-relative normalization, mutation of input scores, or equal-score ordering inherited from a Go map.
- [Agentset filter.ts](https://github.com/agentset-ai/agentset/blob/03283cc6383b96facbec53190ed352079b641789/packages/engine/src/vector-store/common/filter.ts): `BaseFilterTranslator`, `getSupportedOperators`, `isValidOperator`. Take explicit provider support and rejection of unsupported structure, NOT the whole generic algebra. Its defaults include regex and broadly typed values; they are not an Eliot-safe filter policy.

### Confirmed additional finding D19

[Current reciprocalRankFuse](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/retrieval/src/fusion.ts) adds `weight/(k+rank)` for EVERY candidate occurrence. Its `Set` only deduplicates the displayed lane names. Two occurrences of the same source-revision/section in ONE lane therefore increase its score twice, even though the output is one section. This is a static algorithmic defect for duplicate canonical-section inputs, not a measured production incident. #323 repairs delimiter collision; it does not repair repeated voting.

### CODE: ordered changes

1. In `packages/retrieval/src/fusion.ts`, use #323's unambiguous `(source_revision_ref, canonical_section_id)` tuple key. Within each physical ranked list, retain ONE contribution per canonical identity, using its best valid rank. Identical repeated candidates are idempotent. Do not merge conflicting authoritative locator identities by choosing whichever row arrived first; send incompatible identity to the existing strict boundary.
2. Define the representative locator deterministically. Preserve all meaningful ranking contributions as provenance, without pretending each provider-internal signal is a separate request. Keep existing final tie-breaking stable; adding duplicates must not reorder an unrelated candidate.
3. In `packages/retrieval/src/lanes.ts`, `service.ts` and `packages/cloudflare-research-runtime/src/research-retrieval-composition.ts`, keep one governed lane loop. Preserve budget/currentness hooks and domain-error propagation. Remove the duplicated loop and write-only `laneCandidateIds` ONLY after all its consumers use the chosen implementation. No universal plugin runner.
4. Keep `compileAiSearchManagedSearchRequest`, `createD1BackedAiSearchManagedSearchPort`, `decodeAiSearchSearchResult` and `retrieveWithHeldScope`. The primary managed leg makes ONE scoped hybrid call. Its output is ONE already-ranked list; do not feed it back as two artificial LEX+SEM votes. Explicit D1 identifier/exact/literal/exhaustive paths retain their contracts.
5. Apply Agentset's capability idea to the EXISTING #320 filter compiler. Server-owned authority predicate and user narrowing are separate inputs; client input cannot replace the authority predicate. Start with only operators/fields needed by current scope. Unsupported/oversized filter is a typed outcome, not removal of the filter. Do not import regex, arbitrary field names, or provider-specific raw filter strings.
6. AI Search's documented returned-candidate maximum is 50. Derive provider candidate bound from both native cap and existing application policy. Keep provider-candidate, exact-resolution scan, final-evidence and byte budgets separate. This is not authorization for paid fan-out to synthesize a larger top-k.
7. Preserve C13–C16: request digest != scoped invocation identity != output digest; trace+result settle atomically under existing D1 guards; known stale/authority/conflict errors stay nonretryable. No random retry IDs, overwriting old trace JSON, broad catch-to-empty, or secondary unsafe `(error as ...).code` access.

### Result and acceptance

Result: a managed query uses one ranking path and a small local authority/resolution layer. Duplicating one locator within one physical list does not change score/order; an actually independent list may contribute separately according to the declared fusion policy. Record omissions, provider query, ranking generation and stop reason.

Acceptance after assembly: duplicate-in-list invariance; same identity across declared independent lists; #323 colon-pair identity; foreign scope; unsupported filter before provider call; provider-ranked list counted once; invalid top-1 with bounded backfill; same-key replay without retrieval; different invocation without trace collision; typed denial remains denial. Quality/latency/cost claims require measured fixtures, not this source comparison.

DOCS: ER-04 and R02 describe physical list versus signal, supported filter subset, new identity generation and partial settlement. Do not claim public literal support: `checkLiteralsMax` currently REJECTS nonempty literals, so the `literals: []` caller is not evidence of a present accepted-request data-loss bug. Future literal support must update parser, execution and replay together.

<a id="b2"></a>
## B2 — #244: strict reconciliation on the existing projection stores

### Donor code actually inspected

- [LightRAG base.py](https://github.com/HKUDS/LightRAG/blob/453dce83d6d0354a06e46c8d4029a0895c4e054b/lightrag/base.py#L1380-L1680): `CursorPosition`, `CursorAfter`, `DocSchedulingRecord`, `DocStatusPage`, `DocStatusStorage.get_docs_by_statuses`. The control-plane contract is complete-or-raise. An empty filtered page is not necessarily the end. These are inspected contracts, NOT proof that every storage implementation is correct.
- [Onyx swap_index.py](https://github.com/onyx-dot-app/onyx/blob/f858083d6cbe37c4146834d379e39511260a9879/backend/onyx/db/swap_index.py): `_required_cc_pairs_for_switchover`, `_ported_documents_present_in_new_index`, `_perform_index_swap`. Take shared required-set logic, writer/reconciliation gates and checking the target index. Sample presence is not full completeness; a configured probe count of zero must not become Eliot validation evidence. Do not transplant SQLAlchemy/Redis or the whole swap implementation.

### CODE: ordered changes

1. Keep the existing chain in `packages/cloudflare-ai/src/projection-execution-delivery-handler.ts` and `packages/cloudflare-projection/src/managed-index.ts`: `createProjectionExecutionDeliveryHandler` -> `createManagedProjectionPort` -> `indexItem`. Retain `managedItemFilename`, `decodeItem`, `assertExpectedMetadata` as the narrow native boundary after the S52 compatibility fixes.
2. Preflight the entire bounded desired item set before the first upload: exact source/generation, valid provider key, document bytes, metadata and limits. A bad final item cannot be discovered after uploading the earlier items.
3. Read desired identities from the EXISTING projection manifest/job. Add missing per-item settlement fields only to its owning store/receipt, not a new DocumentProcessState subsystem. Reuse exact item provider ID when known. UNKNOWN upload remains UNKNOWN until exact readback; timeout does not mean zero effect.
4. For a required reconciliation scan, use a small scheduling projection and a stable D1 keyset/high-water boundary. Hydrate heavy manifests/errors/content only for the item being processed. Validate each page and consumed position; duplicate/malformed/incomplete page fails the scan. Advance only after processing or durably recording that item's outcome. Explicitly record complete scan versus stopped/degraded scan.
5. Do not invent Cloudflare cursor methods: documented `items.list()` uses `page`/`per_page`, whereas item logs use an opaque cursor. A local LightRAG-style cursor describes Eliot's D1 manifest traversal, not a stable native Items listing. Prefer desired-set ID reads over treating a mutating, page-number provider listing as an authoritative inventory.
6. Reuse `createAiSearchGenerationRegistryService`, `createD1AiSearchGenerationRegistryStore`, `assertImmutableAiSearchProfile` and `projectionManagedGenerationIsActive`. Before existing promotion/CAS, reconcile the required item set, profile/digests and current purge/owner authority. Ensure no permitted stale writer can change the qualified set across promotion; inspect existing fencing before adding any field. Do not add a second active-generation pointer.
7. Readiness layers stay distinct: upload accepted; processing completed; metadata readback; downloaded bytes verified where required; generation qualified; active pointer changed. Native item chunks are provider locators, never canonical EvidenceHandles.

### Result and acceptance

A partial upload/reconciliation cannot be reported as a fully qualified generation. A no-op exact item is not uploaded again merely because the process restarted. Preserve the current generation on failed build. Bounded sample probes supplement manifest/count checks and do not replace them.

Acceptance after assembly: invalid tail -> zero uploads; lost ACK/readback; duplicate/missing provider item; empty filtered middle page with later work; malformed page -> no complete receipt; concurrent generation/purge change blocks promotion; unchanged desired item avoids extra upload; failed B preserves A. No latency or resource saving is claimed before measurement.

DOCS: ER-38 and S52 distinguish page completion, whole-scan completion, provider status and promotion. LightRAG `from_stored` ignores unknown fields: DO NOT copy that permissiveness to Eliot's strict authority-bearing wire schemas.

<a id="b3"></a>
## B3 — #233: one prepared context shared by manifest, prompt and validation

### Donor code actually inspected

[DocsGPT attachment_budget.py](https://github.com/arc53/DocsGPT/blob/0d994485d2ac5e3a1eff6020ccbe7d4f99adc612/docsgpt/agents/attachment_budget.py): `compute_attachment_budget`, `AttachmentPlan`, `PlannedFile`, and the `plan_attachments` entry point. Planning is separated from rendering/I/O; large optional files do not prevent later fitting files; omissions carry dispositions.

Corrections to a literal transfer of the supplied registry: this file describes F1..Fn as CONVERSATION-scoped, not merely turn-local; earlier-turn files are not inlined again. Eliot stages are independently bound calls. Do not assume a later model call remembers an earlier file. Do not reuse a source just by content hash or filename+size across residency/owner/scope boundaries. Fixed PDF/image token estimates and reserve percentages are not qualified Eliot model profiles.

### Existing code to extend, not replace

- `packages/policy/src/context-compiler.ts`: `createEvidenceContextCompiler`.
- `packages/cloudflare-evidence/src/research-reference-manifest.ts`: `buildAllowedReferenceManifest`, `createResearchReferenceManifestService`, `buildAndPersist` interface; allowed-use intersection and exact handle/source binding stay here.
- `packages/cloudflare-model-control/src/research-model-prompt.ts`: `createResearchModelPromptCompiler`, `assertInputBinding`, `userPayload`, final `validateModelGatewayRequestBody` call.
- `packages/cloudflare-research-runtime/src/research-synthesis-prompt.ts` and `research-branch-role-server-prompt.ts`: server-owned question/profile inputs.
- `packages/cloudflare-research/src/artifact-cow-section-producer.ts`: `compileSection`, `validateCurrentEvidencePack`, `validateCitedEvidence`, independent verification.

### CODE: ordered changes

1. Preserve S41 A: execution_product is bound before dispatch; retrieval product and artifact kind remain separate. Do not add more product enums as a substitute for actual ASK/BRIEF plans.
2. Prepare immutable question/profile/manifest inputs once per model request. `prepare_compilation` is a PROPOSED private seam, not an existing function. If introduced, migrate its callers atomically rather than keeping two permanent callbacks plus a new third path. It replaces repeated heavy preparation, not the manifest authority checks or provider capability validation.
3. The prepared context reserves room for the trusted question, system instructions, response schema/tools where present, serialized wrappers/selection receipt, and output. UTF-8 transport bytes and model tokens are DIFFERENT budgets. Use the selected model's qualified capability/tokenizer policy; record estimate versus observed usage. Do not invent an exact token measurement from character count.
4. Plan required versus optional evidence inside the existing compiler/profile and retain its selection receipt. Every required claim/evidence constraint must fit or yield a typed budget/debt outcome before a paid call. Optional oversize item can be skipped and later fitting items considered. Do not remove a required qualifier, comparison side or counterexample simply to fill the window.
5. Do not truncate an exact excerpt silently. Select a smaller independently resolved span with a new valid handle, or omit it explicitly. Short aliases map to the existing AllowedReferenceManifest, not another citation registry. Summary/abstract is navigation or derived output, never upgraded to original evidence.
6. After normalization in Artifact COW, move `maximum_utf8_bytes` and local trusted-input/claim-set checks BEFORE INDEPENDENT_VERIFY. Keep original model-output receipts for recovery and preserve independent claim audit. No blanket catch/retry or hidden second model call.
7. Keep `validateModelGatewayRequestBody` as the final full-serialized-envelope backstop. Planning should prevent predictable overflow; passing an evidence-text sum alone is not sufficient. Persisted/compiled manifest refs, selected handles and prompt-body digest must agree.

### Result and acceptance

ASK and each BRIEF section have one reproducible context selection. No second context service, no full-file attachment ingestion engine, no mandatory conversation memory. Existing exact evidence and COW/publication remain authoritative.

Acceptance after assembly: escaped/Unicode text with wrapper/schema overhead; mandatory evidence too large -> no verifier call and explicit outcome; optional oversize first item does not waste the rest of the budget; duplicate bytes across different residency identities not merged; independent stage receives its bound context; alias outside manifest rejected; repeated request has the same context digest; source revoke still blocks output; old v1/v2 run decoding preserved.

DOCS: S41 backend plan and named prompt/manifest ownership sections only. Public API changes require a small versioned handoff to the UI owner; this task does not edit UI pages, renderers or frontend documentation.

<a id="b4"></a>
## B4 — #214: contradiction candidates, not destructive fact updates

### Donor code actually inspected

[Cognee detect_contradictions.py](https://github.com/topoteretes/cognee/blob/0ec7a9fa61c9ff04bf7e02e0d57af363a993a5e1/cognee/tasks/graph/detect_contradictions.py): `_collect_touched_node_ids`, `_build_candidate_facts`, `_contradiction_endpoints`, `detect_contradictions`. Take bounded candidate presentation, server-issued F IDs, selecting the stored server fact text, and non-destructive annotations.

Do NOT copy: a confidence threshold as truth; catch-all suppression for a REQUIRED counter branch; endpoint-pair identity in place of fact revisions; unbounded neighborhood materialization before the fact limit. In the inspected code `get_neighborhood` happens BEFORE `_build_candidate_facts(limit=...)`, so its fact cap does not prove bounded upstream graph reads. Eliot does not need a graph database for this slice.

### CODE: ordered changes

1. #325 first establishes immutable root/branch questions and a typed findings envelope. Use existing `retrieveWithHeldScope` for the actual counter query. Do not run a second analysis of the old pack and label it a search.
2. In `packages/cloudflare-research-branches/src/research-branch-execution-results.ts`, retire `evidenceForRole` substring classification as authority. Keep `buildRoleResultFromModelOutput` and `debtFor` as the existing translation seam, evolving their versioned contract where needed.
3. Candidate rows bind a server-issued local alias to question/hypothesis/claim, exact handle revision and source revision. Returned aliases are validated before any relation is recorded. Use the existing branch envelope to express CONTRADICTS/QUALIFIES/ALTERNATIVE candidates; do not add a parallel graph journal.
4. Bound candidates, examined spans and proposed pairs BEFORE expensive reads/model calls. Compare units, population/conditions and source-bound time intervals before asking for contradiction. Missing context/time is UNKNOWN, not an invented overlap or automatic rejection.
5. Keep candidate relation separate from verified disposition. Preserve both original statements and their source handles. `unresolved_contradiction_refs` must point to actual candidate records, not automatically to every COUNTER-selected handle.
6. Coordinate `packages/contracts/src/research-branch.ts`, `research-branch-role-output.ts` and `research-evidence-freeze-branch-lineage.ts` with #325. Freeze includes both sides and limitations. Existing claim audit assigns supported conclusions later; do not make a downstream audit a cyclic prerequisite of an earlier stage. Post-freeze evidence uses existing reopen/revision.
7. Optional detector failure may leave base ingestion/search usable, but writes a typed skipped/degraded outcome. A required counter-search failure remains a ResearchDebt and affects completion. Never equate silence, no-hit, unavailable and exhaustive absence.

### Result and acceptance

Synthesis sees explicit opposing findings with traceable evidence, not only counts of handles. Annotation never overwrites original facts. A model's self-rated confidence cannot promote a contradiction.

Acceptance after assembly: forged F ID; same text at different revisions; two reports about different years/populations; qualification rather than contradiction; required detector unavailable versus optional enrichment unavailable; true counterexample outside initial top-k; capped candidate set with honest coverage; replay does not append duplicate candidates; purge/revoke checked before disclosure.

DOCS: R04 and architecture §§7.8–7.9 preserve candidate versus authoritative result and completeness vocabulary. Graphiti temporal fields remain a separately qualified future extension; do not require its database/runtime before this repair.

## Additional registry entries: what is NOT a baseline dependency

| Registry mechanism | Eliot decision in this pass |
|---|---|
| WeKnora lazy registry/singleflight | defer a new registry; existing D1 managed/model registries remain. Process-local dedup cannot own paid cross-isolate attempts |
| PipesHub hierarchical DRR/heavy-light pools | useful design if measured starvation exists; native Queue bounds and existing dispatch first. Redis/Kafka/process scheduler not introduced |
| OpenViking L0/L1 sidecars | use later as derived navigation artifacts with source/generator digest and max staleness; do not replace source evidence or create another context filesystem |
| Onyx connector interfaces | reuse when a new connector is actually commissioned; not a prerequisite for fixed-source ingestion or present Research repair |
| Haystack typed component/allowlist | compare with existing typed stage factory; no generic graph DSL or dynamic deserialization framework added |
| SurfSense citation numbering | reuse the idea only through Eliot's existing manifest; no second ID authority or global KNN-before-scope design |
| Dify/RAGFlow graph runtimes | reference failure/resume cases only; Cloudflare Workflows stays the executor |
| Graphiti/Cognee graph storage | no new graph database; versioned candidate findings first |

These rows are registry-derived triage, not a fresh full audit of those modules. The six inspected donor modules above are pinned snapshots, not claims about latest releases, all CI, SaaS support or benchmark superiority. No third-party code is copied in this documentation change. Literal copy/package adoption requires file-level license and transitive dependency review; a registry TAKE label is not that review.

## Deletion/reuse contract — how this reduces code rather than adding layers

Every implementing PR must name: the old function/path that becomes unused; its new owner; all migrated consumers; compatibility reader retained and why. Delete the superseded implementation in the same coherent checkpoint once no active consumer needs it. Keep public/historical codecs only with explicit scope; an unexplained permanent dual path fails review.

Immediate targets: duplicate lane loop; repeated unsafe error-code readers; write-only laneCandidateIds; repeated prompt preparation; leaf-local byte readers once #321 and domain mapping are integrated. Generation registry, R2 evidence authority, D1 outbox and independent claim audit are NOT duplicates merely because a platform offers related transport features.

Do not use reduced line count as the sole result. Record physical provider calls, examined/resolved counts, D1/R2 reads and serialized bytes for the same input; memory/latency/cost improvement remains unclaimed until measured. Moving unchanged code to another package is not a speedup.

## Integration and required handoff

Order: #320/#324 -> #242; #325 -> #214; #233 uses #242 and existing Artifact COW; #244 keeps its existing generation interface and does not wait for GraphRAG/context redesign. Common prompt/contract changes are scheduled by one integrator, not edited concurrently by #233/#325.

Code-first gates at implementation: installed TypeScript compilation + scoped ESLint; SQL depth-100 for migrations/queries; minimal Clippy only when Rust actually changes. Broad unit/browser/native/quality suites remain deferred until assembly under the owner's phase rule. Preserve the negative scenarios above as PENDING; never claim a Markdown check as runtime PASS. No automatic workflow dispatch, live provider call or deployment.

Each final implementation handoff must contain: baseline/head SHA; exact changed files; donor function and pinned URL; existing function reused; duplicate removed; API/generation/legacy effect; actual commands/results; pending native/quality work. A blocked item identifies one specific dependency, not a request to redesign the entire project.

## Review record

This pass read six pinned donor modules (WeKnora, Agentset, DocsGPT, LightRAG, Onyx, Cognee), selected Eliot source/callers, existing PR passports and current Cloudflare documentation. It did not deploy donors or run comparative quality/load tests. A full local source archive was not obtained (archive access path failed and container DNS was unavailable); authenticated GitHub reads/writes remained available. No whole-repository compilation/dead-code proof is claimed. D19 is static reasoning from the actual fusion loop; no native reproduction is asserted.
