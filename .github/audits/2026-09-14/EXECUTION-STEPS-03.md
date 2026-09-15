# Execution steps 03 — deterministic kernel and final acceptance

These are the ordered checkpoints for S78–S97. Existing PRs remain the work items; this document removes the need to invent a family split or a second verification system. Baseline `a2aca127`; use current main when implementing.

## Verified starting state and reusable commands

`Cargo.toml` currently includes exactly `eliotr-canonical`, `eliotr-test-vectors`, and `eliotr-kernel-wasm`. The actual `eliotr-canonical/src/lib.rs` exports canonical JSON/errors, generation, owner-token, residency-key, scope-snapshot-identity, SHA-256 and stable-ID primitives. It does **not** establish that owner transitions, policy, coverage or the entire research kernel already exist in Rust. Conversely, those existing primitives must not be rewritten just because a broad migration task mentions them. Target crates named by the language contract are intended additions, not existing files.

The matching vector crate currently contains canonical-body, owner-token, residency-key, scope-snapshot-identity and stable-ID families. Preserve those fixtures and completed K1/K2a results. New family cases extend the same conformance system.

During a pure family checkpoint use the existing pinned toolchain and `cargo test --locked -p <actual-crate>`, plus its shared-vector comparison. Before accepting the family run `pnpm rust:fmt`, `pnpm rust:clippy`, `pnpm rust:nextest`, `pnpm rust:deny`, `pnpm rust:check-contracts` and the applicable existing coverage/mutation gates. `pnpm rust:wasm` builds the existing shell; self-test success alone is not runtime integration. W means the actual core Workers test command defined in steps01, not root Vitest or node:sqlite. Run broad mutation/load gates at their intended checkpoint, not after every formatting edit.

For every family use this finite sequence: **A** capture the existing TS input/output/error contract and independent fixtures; **B** implement the pure Rust function in the language-contract target crate, reusing canonical primitives; **C** run TS/native/Wasm parity and mutation negatives; **D** switch actual callers and remove replaced TS decisions under S89. A/C may discover a real reference defect; correct it explicitly rather than silently blessing it as parity. Domain Rust uses `forbid(unsafe_code)`, no network, platform handles, implicit clock or hidden authority globals.

## S78 — remaining canonical identities · [#270](https://github.com/UnknownAlienHuman/eliot-research/pull/270)

Perform these named checkpoints independently, in order; each ends with exact before/after bytes/errors and the shared native/Wasm vector result:

| Checkpoint | Existing starting point | Required delta and negative oracle |
|---|---|---|
| 78.1 | canonical JSON modules exported by `crates/eliotr-canonical/src/lib.rs`; vector `canonical_body` | Close remaining canonical-body.v1 cases: admitted numeric domain, UTF-16 key ordering, Unicode escaping, malformed/lone-surrogate and bound failures. Do not impose this numeric subset on a different wire format. |
| 78.2 | exported `stable_id` and its existing vectors | Verify domain-separated hash/ID inputs including empty, changed domain, max/max+1 and malformed encoding. Preserve existing persisted IDs. |
| 78.3 | exported `residency_key` and owner-token primitives | Verify complete residency/cutover serialized identities against actual TS contracts. Equal content with different owner/key/retention cannot produce an interchangeable authority key. Keep K1 unchanged. |
| 78.4 | `scope_snapshot_identity` and existing K2a vectors | Retain K2a; extend only genuinely missing scope identity cases after S08/S99 input changes. This is identity, not S80's set algebra. |
| 78.5 | actual ingest/projection request codecs located by their imports from domain/contracts | Add only missing serialization identities to the existing conformance corpus. Same logical operation has one ID; changed revision, parser or generation must not replay the old identity. |
| 78.6 | exact active evidence/freeze/artifact/federation codec callers | Record each active family's actual function and reuse-compatible primitive; incompatible byte formats keep distinct named codecs. Compare all stored golden digests. Delete only the specific equivalent TS duplicate authorized by S28 or later S89. |

**Done:** each named active family has caller→function→fixture→TS/native/Wasm result, stored in the existing Launch09 family table. Unfinished mutation work in #176 remains visible; a line-count or Rust percentage is not acceptance. No new serializer registry or wholesale 26-function replacement.

## S79 — owner lifecycle · [#271](https://github.com/UnknownAlienHuman/eliot-research/pull/271)

**79.1:** use `packages/domain/src/source-ownership.ts::validateOwnershipTransition` and `assertSingleActiveOwner`, then `owner-cutover.ts` and their real adapter callers, as the initial TS decision boundary. Preserve exact namespace/revision/status/generation/error semantics; an unverified boolean from a client is not a bilateral receipt.

**79.2:** implement pure typed owner transition/cutover decisions in the documented `eliotr-state-machines` target, sharing S78 tokens/IDs. **79.3:** valid ACTIVE/cutover/fenced/retired, stale fence, changed namespace, foreign unilateral transfer, replay and dual-active-owner fixtures must match TS/native/Wasm. SQL CAS still validates the current state at commit. **79.4:** S89 switches this family only after actual owner-adapter W tests; no new ownership service.

## S80 — scope algebra/currentness · [#272](https://github.com/UnknownAlienHuman/eliot-research/pull/272)

**80.1:** use `packages/domain/src/scope.ts`, `scope/deterministic-resolver.ts`, and current navigation scope-service callers to capture normalization, UNION/INTERSECT/EXCEPT, ordering and explicit currentness inputs. Scope serialization already in S78 is reused.

**80.2:** implement pure algebra/currentness in documented `eliotr-scope`, with explicit authorized atom/member/policy/purge/time facts. **80.3:** nested sets, empty/duplicate/permuted input, forbidden atom, member/policy/head changes and historical versus active scope must preserve TS outcomes. No silent truncation or wider scope after renewal. **80.4:** integrate through S89, running S08/S33/S99 W regressions. Enumeration/grant writes stay TS/D1.

## S81 — policy/residency/budget · [#273](https://github.com/UnknownAlienHuman/eliot-research/pull/273)

**81.1:** isolate the existing fixed-order policy evaluator, `packages/domain/src/residency.ts`, and the pure decision used by `cloudflare-research/src/research-model-spend-admission.ts`. Do not port native Gateway HTTP, JWT verification, reservations or encryption I/O.

**81.2:** implement the documented `eliotr-policy`/`eliotr-residency` pure functions over verified observations and explicit time, reusing exact monetary units. **81.3:** viewer/model/client combinations, declassification receipts, wrong residency/key/retention, expired policy, insufficient quote and numeric overflow match the TS decision/reason. Budget exhaustion still allows permitted exact reads. **81.4:** S89 switches the real authorization/spend callers with W tests; no new budget or permissions framework.

## S82 — source qualification and CLI · [#274](https://github.com/UnknownAlienHuman/eliot-research/pull/274)

**82.1:** extract the actual decision inputs from `packages/domain/src/source-admission.ts` and `qualification.ts`; preserve original/normalized identities, coordinate-map precision and ownership/residency observations.

**82.2:** implement pure qualification/admission in documented `eliotr-qualification`, not an OCR/PDF engine. **82.3:** add the thin `eliotr-bundle-cli` adapter over the same functions: stream native file hashing, validate a local bundle, print a bounded machine-readable verdict, and return failure status for invalid bundles. CLI success neither admits a source nor issues a grant. **82.4:** valid/degraded/corrupt/foreign/missing-map Windows/Linux fixtures and actual S47/S98 ingress tests pass; S89 performs Worker promotion separately.

## S83 — structural projection · [#275](https://github.com/UnknownAlienHuman/eliot-research/pull/275)

**83.1:** take inputs/outputs from the existing structural materialization path exported by `cloudflare-navigation/src/index.ts` and qualified coordinate-map adapter; distinguish source bytes from parser-provided maps.

**83.2:** implement pure segmentation/range/map/item transforms in documented `eliotr-projection-core` using explicit base offsets and generation refs. **83.3:** prose/code/table/Unicode/chunk-boundary fixtures match items/maps/IDs, and invalid parent cycles/ranges/foreign maps fail. No embeddings/tokenizer/BM25 replacement. **83.4:** the explicit ABI extension in S88 exposes this transformation; S89 replaces the real projector decision, while TS retains Queue/R2/D1/index activation. Run S48/S52 W regressions and bounded-memory measurements.

## S84 — evidence and coverage · [#276](https://github.com/UnknownAlienHuman/eliot-research/pull/276)

**84.1:** capture pure invariants in `packages/domain/src/evidence.ts`, `coverage.ts`, `completion.ts` and actual resolver/coverage callers. TS first obtains and validates the observations from real storage.

**84.2:** implement pure exact resolution and coverage in documented `eliotr-evidence`/`eliotr-coverage`; retain revision/hash/length/range/map/owner/scope/purge checks, eligible/represented/cited/omitted sets and source-family independence.

**84.3:** positive evidence and wrong digest/range/foreign/purged/partial denominator cases match. Identical shard redelivery is deduplicated; conflicting duplicates fail and never replace missing shards. Sampled no-hit cannot prove complete absence. **84.4:** S89 switches actual resolver/exhaustive callers with S48/S51 W regressions. Storage reads and final currentness before disclosure stay TS.

## S85 — Research/acceptance/publication · [#277](https://github.com/UnknownAlienHuman/eliot-research/pull/277)

**85.1:** use `packages/research/src/ledger-commands.ts` mutation masks, `ports.ts` W1 states and actual domain investigation/completion/publication decisions after S35–S40/S54 fixes. Do not port old technical placeholders as completed research.

**85.2:** implement pure transitions, freeze lineage, required verifier/grade/waiver/coverage and publication decisions in documented `eliotr-research-core`, reusing other pure families.

**85.3:** all allowed W1 transitions and existing nine dispositions match; model self-certification, changed metric after exposure, changed freeze, edited claim inheriting an old audit and stale head fail. **85.4:** S89 replaces only the domain decisions. Existing W1 SQL commands/CAS, Workflow, models and R2 effects stay TS/platform. S36's protected portfolio/debt masks and S40's supersession tests remain mandatory.

## S86 — erasure closure · [#278](https://github.com/UnknownAlienHuman/eliot-research/pull/278)

**86.1:** take the current S63 coordinator's expected closure and actual observation contract, not a count of deletion ACKs. Bind domain/object/version/residency, retention hold and explicit current time.

**86.2:** implement pure close/pending/blocked admissibility in documented `eliotr-erasure-core`. **86.3:** exact full closure succeeds, missing/foreign/locked/conflicting observations do not; legal repeated observations deduplicate and late dependencies invalidate insufficient proof. **86.4:** S89 changes the actual coordinator decision and repeats S63/S66 W tests. Deletion, remote readback and purge-ledger append are not Rust I/O and no old receipt is rewritten.

## S87 — federation fence and mapping · [#279](https://github.com/UnknownAlienHuman/eliot-research/pull/279)

**87.1:** use the existing S60 federation service's verified request/fence/bridge/manifest and result mapping contract. Keep independent S61 wire fixtures as the oracle; don't import the server codec into both sides of the test.

**87.2:** implement pure fence/admissibility and internal-to-wire disposition mapping in documented `eliotr-federation-core`. **87.3:** stale/foreign/unknown-version/substituted-manifest cases fail, transport COMPLETED never strengthens PARTIAL/INCONCLUSIVE/UNKNOWN, and a peer candidate never becomes admitted authority by itself. **87.4:** switch under S89 and rerun independent client tests. HTTP auth, job storage, streaming and provider execution remain TS; W2/W3 identity separation stays intact.

## S88 — finite ABI design and actual shadow · [#280](https://github.com/UnknownAlienHuman/eliot-research/pull/280)

The language contract explicitly permits six initial exports, not an unspecified universal dispatcher. Required policy evaluation and projection transformation need an explicit interface decision, not naming games. Use these checkpoints:

**88.1 — Contract amendment before implementation.** In the existing LANGUAGE_RUNTIME_CONTRACT, make a scoped backward-compatible revision documenting the two added product exports below. Preserve all six initial exports and their meanings. This is the chosen amendment for mandatory families, not permission for arbitrary extra exports. Keep one strict versioned envelope and per-operation input/output schemas in the existing contracts package; no new registry/service.

| Product export | Closed operation family |
|---|---|
| `eliotr_canonicalize_v1` | S78 canonical/identity serialization operations |
| `eliotr_validate_transition_v1` | S79 ownership, S85 W1/publication, S86 erasure-close, and S87 fence/admissibility transitions, each with its own admitted `operation` and schema |
| `eliotr_resolve_scope_v1` | S80 scope normalization/algebra/currentness |
| `eliotr_qualify_bundle_v1` | S82 normalized bundle/source qualification |
| `eliotr_validate_evidence_resolution_v1` | S84 exact evidence invariants |
| `eliotr_map_completion_disposition_v1` | S84/S85/S87 completion mappings without stronger outcomes |
| **added:** `eliotr_evaluate_policy_v1` | S81 policy/residency/budget admission decisions; not native model routing |
| **added:** `eliotr_transform_projection_v1` | S83 structural byte/map/item transformation; not managed indexing or inference |

The added exports cannot be silently deployed under the old export contract. The revision and its ABI fixture are part of this task, reviewed before switching callers. Unknown export/operation/schema is rejected, never dynamically loaded.

**88.2 — Transport shell.** Use the existing kernel-wasm crate and one TS adapter with the selected pinned wasm-bindgen byte-array glue initialized from the imported precompiled Module. Keep generated technical pointer/memory plumbing inside glue; domain callers pass canonical bytes, not platform objects. Validate byte bounds before marshalling; validate schema/version/hash at the appropriate decoded boundary and output bounds afterward. No workers-rs rewrite or Rust RPC service.

**88.3 — One real family first.** Call canonical identity on runtime input through actual workerd, then compare TS/native/Wasm output. Embedded-vector self-tests alone do not close this checkpoint. Add size/version/hash/truncation/trap cases and repeated-call memory cleanup.

**88.4 — Side-effect-free shadow.** Shadow the same observed input for a ready family; only the existing authoritative path performs effects. Mismatch/trap blocks the affected authority operation and produces content-free diagnostics; never silently use a permissive fallback. Then add each remaining admitted family to the closed operation mapping without a new transport.

**Done:** actual workerd reaches compiled Wasm, inputs/errors agree, effects occur once, memory stays bounded, and compressed JS+Wasm/glue, startup/heap and CPU are measured. S89 owns production switching. The explicit amendment removes an implementation choice the earlier six-export-only task left unresolved.

## S89 — caller switch and deletion, one family at a time · [#281](https://github.com/UnknownAlienHuman/eliot-research/pull/281)

Use the following repeatable unit, not a whole-project language migration commit:

1. Select exactly one accepted S78–S87 family and its actual TS caller; retain native/Wasm/parity/negative/mutation/Worker/performance evidence and the approved ABI revision.
2. Change that caller to consume the Rust decision; keep TS strict wire bounds and platform I/O, and keep SQL's final currentness/CAS. Wrong ABI or trap fails the affected operation rather than executing a hidden TS fallback.
3. Run the same caller test with the old TS decision disabled. Confirm digest/ID/error/replay/history and denial behavior, then remove the replaced TS production decision and rerun. Reference fixtures are retained.
4. Record the per-family implementing SHA/result in existing Launch09. Repeat for the next named family. The aggregate stays open until every mandatory family has one demonstrated runtime owner.

**Done:** actual owner/scope/policy/admission/projection/evidence/Research/erasure/federation paths use their accepted kernel decisions without duplicate effects or changed historical bytes. Unknown upgrade compatibility is not assumed; preserve saved runs, use proven transition/rollback behavior, and test affected old runs. Existing #176 mutation debt, Rust deep checks, W/B/headless regressions and S90 budgets remain applicable. Do not measure success by language percentage.

## S90 — measured budgets · [#282](https://github.com/UnknownAlienHuman/eliot-research/pull/282)

**90.1:** correct `scripts/check-budgets.mjs` to measure emitted Worker JS+Wasm and initial first-party PWA JS rather than present raw source bytes as runtime quota. Keep readable source counts diagnostic, with the explicit procedural-doc change already requested by the owner.

**90.2:** use existing build/dry-run/runtime measurement tools for compressed size, startup, heap and operation CPU. Preserve documented repository targets and actual security envelopes; do not substitute vendor maxima or raise targets to manufacture PASS.

**90.3:** test a small source importing a large dependency, an oversized emitted artifact, test-only bundle leakage and pure source-file relocation. **Done:** actual artifacts decide the result; missing measurement is NOT_MEASURED and files are not minified/split pointlessly. `pnpm build`, `pnpm wrangler:dry-run`, `pnpm budgets:check`, affected tests and recorded measurement identities. Real workload is S96.

## S91 — finite D1 transaction coverage · [#283](https://github.com/UnknownAlienHuman/eliot-research/pull/283)

S04 already covers project membership and Wiki owner edit. Complete the following batches through **actual application services in W**, not copied SQL or root node:sqlite fixtures:

| Batch | Transaction families | Existing entry points/check commands |
|---|---|---|
| 91.1 | source admission, owner/cutover, project-client grants | `domain` admission/ownership plus core ingest/project routes; ingest/owner/authority checks |
| 91.2 | scope freeze/profile/currentness and renewal | `cloudflare-navigation/src/scope-service.ts`, `d1-scope-service.ts`, historical/owner authorization; source/retrieval checks |
| 91.3 | W1 commands and W2 checkpoints | `research/src/ledger-commands.ts`, `investigation-service.ts`; research/workflow checks |
| 91.4 | W3 attempt/reservation/readback | `cloudflare-research/src/model-attempt-store.ts`, spend-admission and recovery callers; model-admission/recovery checks |
| 91.5 | outbox/inbox/lease settlement | existing delivery stores/consumer/reconciler; delivery/recovery checks |
| 91.6 | index serving-generation CAS | existing S52 generation stores; retrieval/source checks |
| 91.7 | artifact publication/dependency state | current report/Wiki publisher and manifest producers; artifact/research checks |
| 91.8 | purge/closure/holds and backup nonce/replay authority | existing erasure coordinator and O2 stores; erasure/backup/recovery checks |

For each batch reuse an existing real-D1 test where it already exists. Add only missing positive commit plus stale/invalid/concurrent/lost-ACK negative cases, reading canonical row/head/receipt/outbox after execution. Check fresh-schema and supported upgrade paths without rewriting merged migrations. **Done:** no active family is counted merely because migration SQL compiles; D1 depth/bind/batch issues are caught locally and refusals leave no partial authority effects. Keep fast pure tests for their real purpose, and report exact service→test→result within the existing task, not another registry.

## S92 — executable local product acceptance · [#284](https://github.com/UnknownAlienHuman/eliot-research/pull/284)

Split the existing owner browser harness into these scenario modules with shared fixture setup/cleanup, preserving security tests rather than writing a second harness:

- **92.1 intake:** empty owner→project→raw/normalized import→admission/readiness→exact Library/Lens source.
- **92.2 delegation:** owner-issued grant→independent service normalized ingest→append-only attach→query/run/status→report/citation, including S98/S99.
- **92.3 products:** protocol-bound ASK/COMPARE/FACT_CHECK/DEEP/REPORT through controlled external model responses, actual W1/W2/W3/R2 and exact saved output.
- **92.4 continuity:** JWT refresh, PWA-only deploy, source v1→v2, offline/reconnect, cancel and same-run recover; no duplicate completed effects.
- **92.5 publication:** section edit/review/publish/history/export, with stable unchanged sections and honest claim verdicts.
- **92.6 rejection:** wrong scope/actor, in-flight revoke/purge, corrupt result, stale CAS and late response reveal no private data or false success.

Use exact one-build/schema/config identities, owner API-issued grants rather than manually inserting authority, and controlled external IdP/provider boundaries only. **Done:** focused W/U then complete B/local-documents, current typechecks/build/dry-run/affected checks and both applicable Linux/Windows jobs pass on the same final commit. Native platform semantics are not proven by this local run.

## S93 — quality, not response existence · [#285](https://github.com/UnknownAlienHuman/eliot-research/pull/285)

**93.1:** extend existing Golden fixtures, retaining GC-009–012, with independently labeled exact spans, acceptable claims/conditions and expected omissions before tuning the candidate. Include multilingual long/mixed/table/code/contradictory/tail/no-answer/injection and larger-scope cases.

**93.2:** execute per-product LOCATE/ASK/BRIEF/COMPARE/HYPOTHESIS_REVIEW/FACT_CHECK/PROJECT_VS_LITERATURE_AUDIT/DEEP/REPORT using separate tuning and holdout sets. Record corpus/model/prompt/parser/index generations and actual sample sizes/repetitions.

**93.3:** compare the documented recall, citation, support/contra, coverage/abstention and forbidden-collapse requirements separately; a retrieval threshold is not a guarantee that every generated answer is correct. **Done:** real authorized model/index measurements meet the applicable selected-profile criteria with failures/limitations retained; regressions block the affected generation. `pnpm golden:check` is the local start, not the final live-quality proof. No fabricated external measurements.

## S94 — first complete staging · [#286](https://github.com/UnknownAlienHuman/eliot-research/pull/286)

**94.1:** use existing deploy orchestrator/preflight/resource manifest with a single approved target/secret-reference/budget configuration. Reuse already supplied valid approvals; do not ask for the same optional preference at every checkpoint.

**94.2:** test wrong target, missing binding, partial migration and stale asset markers locally. Build and provision using existing scripts; no raw bypass or second deploy system. Future T4/T6 receipts cannot be prerequisites of the deployment that enables them.

**94.3:** independently read back exact Worker version/tree, D1 schema, R2/Queue/DLQ/DO/Workflow/AI bindings, PWA asset marker and Wasm digest, plus Access protection. **Done:** all actual identities match the tested configuration and production data is untouched; only then run S93/S95/S96. Missing external parameters block this live step, not local implementation of unrelated tasks.

## S95 — native and selected-client conformance · [#287](https://github.com/UnknownAlienHuman/eliot-research/pull/287)

Use prepared existing probes as a thin sequential runner, in these batches:

**95.1** verified Access/API/MCP and exact D1/R2 identity/readback; **95.2** Queue duplicate/lost ACK/DLQ replay and DO eviction/hibernation/cursor replay; **95.3** native Workflow cancellation/recovery and model/gateway UNKNOWN settlement without repeated completed synthesis; **95.4** actual AI Search serving generation/exact locator; **95.5** selected Workspace action/readback and independent authenticated federation peer; **95.6** prepared purge/isolated restore/code-index rollback on approved disposable data.

Each batch binds exact build/target/config/time and expected durable effects. Response-loss injection may discard an ACK, not replace actual execution with success. Fake/stale/wrong-target receipts fail validation; missing credentials/peer capability is NOT_EXECUTED, not a fixture-generated PASS. **Done:** all applicable native failure/denial/replay observations are retained, with idempotent cleanup of only probe-owned resources. Existing approvals suffice; no implicit deletion of real user data.

## S96 — workload and cost · [#288](https://github.com/UnknownAlienHuman/eliot-research/pull/288)

**96.1:** configure the existing load driver for the documented 5/20/50 readers, five interactive sessions, ten queued jobs and two long Workflows. Record actual corpus/cache/cold-warm/build/duration/sample conditions and the approved spend stop rule.

**96.2:** measure operations separately: read/open, model-backed run, ingestion/indexing, recovery. Collect percentiles/errors/throughput/CPU/heap/queue lag and actual usage; estimated costs and later bills are distinct.

**96.3:** test bounded overload, cancel/restart, draining the queue and model-budget exhaustion while authorized exact reads remain usable. **Done:** applicable repository/profile targets pass or a concrete measured owning-task regression remains open; no target inflation, blind retry of paid UNKNOWN, indefinite stress loop or local simulation labeled live qualification.

## S97 — finite release closeout · [#289](https://github.com/UnknownAlienHuman/eliot-research/pull/289)

**97.1:** reconcile existing implementation-status/gap/release/security records against actual callers, negative/replay tests, and current generation-specific evidence. All mandatory selected-profile Slices0–6, S98/S99 and required Rust families are included; optional legacy Google/Slice7 items are not silently added.

**97.2:** check S92 local, S93 quality, S94 exact deployment, S95 native/security and S96 workload results. A component change invalidates affected evidence, not every unrelated result. Missing mandatory behavior cannot be closed by a Markdown status change.

**97.3:** execute the documented source→evidence→Research→accepted publication→federation→Workspace→disposable erasure/clean-restore canaries and retained rollback checks during the approved observation window. Verify current Access/secrets/budget controls, DLQ and overdue erasure conditions.

**Done:** the existing-format release receipt records exact build/schema/search/AI Search/Wasm/assets/auth/transport/model/rollback identities and the release owner's actual acceptance. The result is a qualified version/profile, not an absolute claim that no future bug can exist. This task performs acceptance; it does not absorb unspecified missing implementation into a giant final rewrite.
