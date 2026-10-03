# Execution steps 03 — deterministic kernel and final acceptance

S78–S97, baseline a2aca127; use current main. Existing work items remain the completion records. This revision removes nonexistent verification commands and points the formerly open-ended identity/D1 groups to their finite consumer/test tables. U/W/B/F are defined by [steps 01](EXECUTION-STEPS-01.md). NEW means required test/tool addition, not an already working capability.

## Actual starting point and commands

Current Cargo workspace contains eliotr-canonical, eliotr-test-vectors and eliotr-kernel-wasm. Canonical primitives/vectors include canonical JSON, generations, owner token, residency key, scope snapshot identity, SHA-256 and stable ID. They are not proof that all intended domain crates exist or are invoked in production; do not rewrite completed K1/K2a.

Use these actual package scripts: `pnpm rust:boundaries`, `pnpm rust:vectors`, `pnpm rust:fmt`, `pnpm rust:clippy`, `pnpm rust:test`, `pnpm rust:deny`, `pnpm rust:wasm`, `pnpm rust:coverage`; final aggregate `pnpm rust:check`. rust:test runs nextest and doctests. Target one actual crate during editing with `cargo test --locked -p <actual-crate>`. There are no rust:nextest/rust:check-contracts aliases. Preserve pinned toolchains/lockfiles; a new domain crate is explicitly added where required by the language contract.

Pure-family sequence: A capture the named current TS input/output/error contract with independent fixture bytes; B add missing Rust decision using shared primitives; C native/TS/compiled-Wasm parity and negative/property/mutation cases; D actual caller switch/removal under S89. Domain code has no I/O, implicit time, platform handles or hidden authority globals. Fix a genuine reference defect explicitly rather than promote parity with a bug. Run broad mutation/performance gates at the family checkpoint, not after every formatting edit.

## S78 — fixed identity inventory · [#270](https://github.com/UnknownAlienHuman/eliot-research/pull/270)

Follow the rewritten passport's **finite named producer table**, not the old instruction to find unspecified active codecs. Checkpoints:

- 78.1 canonical body: existing canonical_body implementation/vectors, exact numeric subset/UTF-16 key ordering/Unicode/bounds.
- 78.2 stable IDs/owner token: existing primitives and K1 domain separation/error fixtures.
- 78.3 residency/cutover: existing residency primitive plus domain owner-cutover serialized identity.
- 78.4 scope: existing K2a and actual scope-service/S08 request identity, not set algebra.
- 78.5a–d intake/projection/navigation/query: ingest-validation.ts; structural-projector.ts; navigation-codec.ts/navigation-identity.ts; query-codec.ts/query-persistence.ts/service.ts. Each consumer and core replay test is named in the passport.
- 78.6a–g outputs: evidence canonical/registry/resolution; reference/protocol/evidence freeze; artifact V1/V2 verification; Wiki publication; federation persisted/wire mapping; backup/model intent fingerprints; W1/W2 identity. The passport supplies exact producer files and test paths, not a grep count.

For every row preserve accepted and invalid bytes/errors through the actual producer and native/Wasm; record existing coverage/reuse instead of implementing a duplicate. New identity fields from earlier accepted feature tasks add their fixture to this same corresponding family before that feature closes. Different admitted wire contracts keep their semantics; canonical-body numeric rules do not overwrite others. Run real vectors/boundaries/wasm and row-specific W tests, then R. Existing #176 mutation debt remains. No production-owner claim before S89.

## S79 — owner transitions · [#271](https://github.com/UnknownAlienHuman/eliot-research/pull/271)

79.1 use domain/source-ownership.ts and owner-cutover.ts actual transition inputs, owner/incarnation/fence and verified bilateral facts. 79.2 implement pure decisions in the documented eliotr-state-machines target using S78 identity. 79.3 test valid transfer/retire and stale/foreign/unilateral/changed-set/replay/dual-owner negatives through TS/native/Wasm. 79.4 S89 switches actual admission/cutover callers while SQL CAS still decides current commit. W test/source-admission-service.test.ts test/ingest-promotion-authorization.test.ts and S70 NEW source-owner-cutover-d1.test.ts. Pure success is not a commit receipt.

## S80 — scope algebra · [#272](https://github.com/UnknownAlienHuman/eliot-research/pull/272)

80.1 domain/scope.ts, scope/deterministic-resolver.ts and navigation scope-service define actual set order/algebra/currentness. 80.2 implement eliotr-scope over explicit authorized atom/member/policy/purge/time observations. 80.3 nested UNION/INTERSECT/EXCEPT, duplicates/permutations, empty/forbidden/member changes and historical-vs-active cases must match; no silent truncation/expanded renewal. 80.4 S89 replaces pure decision; enumeration/grant writes stay TS/D1. W test/scope-service.test.ts test/scope-persistence.test.ts test/research-held-scope.test.ts and S99 NEW large-project-history case.

## S81 — policy/residency/budget · [#273](https://github.com/UnknownAlienHuman/eliot-research/pull/273)

81.1 isolate fixed-order evaluator, domain/residency.ts and pure spend-admission decision; keep JWT/network/encryption/reservation I/O outside. 81.2 add documented pure policy/residency functions with exact monetary units and explicit time/facts/receipts. 81.3 viewer/model/client, declassification, residency/key/retention, expiry/revoke, quote/overflow and permitted evidence at budget stop must match. 81.4 S89 switches actual authorizer/spend caller, preserving final SQL guards. W Model and new S10/S69 authorization/disclosure cases. No second permissions/budget framework.

## S82 — source qualification/CLI · [#274](https://github.com/UnknownAlienHuman/eliot-research/pull/274)

82.1 capture domain/source-admission.ts and qualification.ts original/normalized identity, ownership/residency and precision. 82.2 pure eliotr-qualification validates supplied observations, not an OCR/PDF engine. 82.3 thin documented bundle CLI streams local file hashing and calls the same rules, returning bounded machine-readable results and failure status; it cannot issue grants or admit sources. 82.4 TS/native/Wasm malformed/degraded/foreign/missing-map cases and Windows/Linux CLI tested. W Intake/Raw import plus S98. Actual Worker promotion S89; no remote call or bundle mutation in offline verifier.

## S83 — structural projection · [#275](https://github.com/UnknownAlienHuman/eliot-research/pull/275)

83.1 capture actual projection/navigation materialization and qualified map inputs. 83.2 pure documented eliotr-projection-core transforms bounded bytes/base offsets/maps/generation into items. 83.3 prose/code/table/Unicode/chunk-boundary and corrupt range/map/parent cycle/foreign revision cases match exact output. 83.4 expose through S88's explicit added transformation export and switch real projector in S89; Queue/D1/R2/index effects remain TS. W test/navigation-persistence.test.ts test/structural-navigation-q1.test.ts test/retrieval-generation-fences.test.ts plus S52 NEW promotion case. No embedding/BM25/parser replacement; measure bounded allocation.

## S84 — evidence/coverage · [#276](https://github.com/UnknownAlienHuman/eliot-research/pull/276)

84.1 domain evidence/coverage/completion and actual resolver decisions define observed inputs. 84.2 pure documented evidence/coverage retains revision/hash/length/range/map/owner/scope/purge plus eligible/represented/cited/omitted/family sets. 84.3 exact positives and corrupt/foreign/purged/partial denominator negatives match; identical redelivery deduplicates, conflicts fail and duplicates never fill missing members. 84.4 S89 switches real resolver/exhaustive decision while TS performs reads and final pre-disclosure currentness. W test/research-citations-result.test.ts test/research-citation-attempt-binding.test.ts test/research-query-exhaustive.test.ts. Unknown/sampled cannot prove full absence, but a narrow supported answer is not automatically invalid.

## S85 — Research/publication · [#277](https://github.com/UnknownAlienHuman/eliot-research/pull/277)

85.1 use corrected W1 ledger-commands mutation masks, ports and domain investigation/completion/publication rules after S35–S40/S54, not technical placeholders. 85.2 pure documented research-core decisions bind protocol/lanes/verifier/freeze/debts/waiver/grade. 85.3 all legal transitions/nine dispositions/D0–D3 cases match; model self-approval, post-exposure metric edits, changed freeze and inherited audit on edited claim denied. 85.4 S89 replaces domain decision only, not Workflow/models/CAS/bytes. W W1/Evidence/report groups and S36/S40/S54 NEW cases. Protected portfolio/debt fields stay immutable outside supersession.

## S86 — erasure · [#278](https://github.com/UnknownAlienHuman/eliot-research/pull/278)

86.1 capture S63 expected exact closure versus authenticated observations, not deletion-ACK count. 86.2 documented pure erasure-core normalizes identities/holds/injected time and evaluates terminal admissibility. 86.3 full/missing/foreign/conflicting/locked/late-dependency cases match; repeated identical observation deduplicates. 86.4 S89 changes coordinator decision; deletion/readback/purge append remains TS. W test/erasure-coordinator.test.ts plus S63/S66 NEW closure/restore cases. No new deletion engine or rewritten old receipts.

## S87 — federation · [#279](https://github.com/UnknownAlienHuman/eliot-research/pull/279)

87.1 current S60 verified peer/fence/bridge/manifest and completion contract; preserve S61 independent fixture oracle. 87.2 pure federation-core handles admissibility/transition/disposition only. 87.3 stale/foreign/version/manifest substitutions deny; transport COMPLETED cannot strengthen research PARTIAL/UNKNOWN and candidate is not admission. 87.4 switch actual S60 caller in S89; HTTP auth, jobs, streaming and provider remain TS. W test/federation-service.test.ts test/federation-runtime-http.test.ts plus S61 NEW independent-wire case. W2/W3 separation retained.

## S88 — ABI in four checkpoints · [#280](https://github.com/UnknownAlienHuman/eliot-research/pull/280)

88.1 explicitly revise existing language contract for exactly added eliotr_evaluate_policy_v1 and eliotr_transform_projection_v1, preserving six initial names/semantics. The owning passport has the closed eight-export mapping and strict operation schemas; no arbitrary dispatcher or silent contract change.

88.2 one pinned wasm-bindgen byte-array shell/glue over imported precompiled Module, bounded canonical versioned bytes, no platform objects/implicit clock/RPC. Update existing Wasm build/check expectations for the documented admitted exports while retaining CI self-tests; no new no-op aliases.

88.3 **NEW** W test/kernel-wasm-bridge.test.ts sends runtime input to compiled code and checks independent/native output plus malformed/schema/version/hash/size/truncation/trap/repeated-call cleanup. 88.4 shadow ready families with the same facts and exactly one side-effect path; mismatch blocks authority settlement, no permissive fallback. `pnpm rust:vectors`, `pnpm rust:boundaries`, `pnpm rust:wasm` plus the new W test; final R and actual compressed size/startup/heap/CPU. Promotion is S89.

## S89 — ten caller switches · [#281](https://github.com/UnknownAlienHuman/eliot-research/pull/281)

Use owning passport units 89.1–89.10: identity, owner, scope, policy/residency/budget, admission, projection, evidence/coverage, Research/publication, erasure, federation. Each unit selects its accepted family and the actual caller identified above; do not switch the whole repository in one commit.

For one unit: retain parity/negative/shadow/mutation/performance evidence and exact ABI version; switch caller to Rust decision while keeping TS bounds/platform I/O and SQL CAS; disable the old TS decision and run the identical actual service regression; remove that replaced production algorithm and rerun; record SHA/result in existing Launch09. Reference fixtures remain, not a second runtime authority. Wrong ABI/trap fails closed; rollback/old runs/history/purge/idempotency retain exact identities. Use relevant W rows in S91 and new bridge test, then R/B/F at appropriate integration boundaries. Aggregate closes only after all mandatory families; no Rust-percentage target or hidden TS fallback.

## S90 — measured artifacts · [#282](https://github.com/UnknownAlienHuman/eliot-research/pull/282)

90.1 change scripts/check-budgets.mjs to emitted Worker JS+Wasm and initial PWA asset measures, not raw source count as quota. Source-size/LOC remains honest diagnostic under the explicit procedural change. 90.2 use existing build/dry-run metadata and actual runtime measurement; preserve repository targets/security envelopes, record NOT_MEASURED where appropriate. 90.3 **NEW** U tests/build-budget-artifacts.test.ts covers tiny source/large dependency, over-limit output, accidental test shipping and source-file relocation. Run `pnpm build`, `pnpm cf:dry-run`, `pnpm budgets:check`, `pnpm typecheck` and that U test. No wrangler:dry-run alias, target inflation, minification or pointless package splits. Live load is S96.

## S91 — named D1 transaction rows · [#283](https://github.com/UnknownAlienHuman/eliot-research/pull/283)

The rewritten five-part passport now lists the exact existing core filenames and explicitly NEW additions from owning features; it supersedes its old table of nonexistent owner/authority/research/etc scripts. Eight rows:

91.1 bundle/source/owner/grant/append-only project attach; 91.2 scope freeze/persist/currentness/renewal/history; 91.3 W1 masks/CAS and W2 lifecycle; 91.4 W3 attempt/reservation/fingerprint/pricing/output; 91.5 outbox/inbox/lease/DLQ settlement; 91.6 index readiness/shadow/serving CAS; 91.7 freeze/report/artifact/Wiki/dependencies; 91.8 erasure/hold/backup nonce/replay/isolated readiness.

For each named operation: actual service with real core DB before/after rows/heads/receipts/outbox, valid commit, same-key replay, stale/malformed/foreign/concurrent/lost-ACK/currentness negatives, maximum admitted shape and fresh/upgrade migrations. Existing sufficient W cases are reused; helper-only/DatabaseSync is not actual-D1 proof. NEW test names only count after implemented. Failed write cannot partially publish; final SQL invariants remain. Run exact W file selection and listed real supplemental checks, then full W suite. One positive representative cannot close an entire row; no second coverage registry.

## S92 — local product acceptance · [#284](https://github.com/UnknownAlienHuman/eliot-research/pull/284)

92.1 intake: empty owner→project→raw/normalized admission/readiness→exact Library/Lens. 92.2 delegation: owner-issued grant→independent machine ingest/append-only attach→query/run/status→report/citation, including S98/S99. 92.3 products: registered ASK/COMPARE/FACT_CHECK/DEEP/REPORT through actual W1/W2/W3/storage and controlled external model. 92.4 continuity: JWT refresh/compatible deploy/source v1→v2/offline/cancel/same-run recover. 92.5 COW review/publish/history/verified export. 92.6 negative actor/scope/revoke/purge/corrupt/CAS/late replies.

Split these into named scenario functions/modules under the existing browser harness and register actual node:test assertions in tests/integration/browser/library.spec.ts; each new scenario must be reached by the real runner, not stored as unused code. Share safe setup/cleanup, preserve infrastructure/security negatives, no new browser framework. Focused W/U while editing; automated B is `pnpm test:owner-e2e`. For exact original browser reproduction use its known L6 real-browser owner harness name filter as documented in steps01. Interactive local:owner is separate manual inspection, not PASS.

Done: one build/schema/config, true owner/API-issued grants, actual app/storage/Queue/DO/Wasm, same allowed IDs/hashes/dispositions, zero repeated completed effects. Run `pnpm test:local-launch`, `pnpm test:local-owner`, `pnpm local:prepare`, `pnpm local:smoke`, B, `pnpm cf:types`, `pnpm build`, `pnpm cf:dry-run` and full F at final local acceptance on applicable CI platforms. No local:documents or base-filter assumption. Controlled external tests do not establish native/live behavior.

## S93 — adjudicated quality · [#285](https://github.com/UnknownAlienHuman/eliot-research/pull/285)

93.1 start with actual tests/golden-corpus/manifest.json, cases/sources and packages/testkit/src/golden.ts; preserve GC-009–012 and the established fixture LF hashing rules. Executable local check: `pnpm exec vitest run tests/golden-corpus/golden-harness.test.ts`. This is the real starting command, not golden:check. Fix fixture/test expected case counts when intentionally expanding the manifested corpus; do not silently drop old cases.

93.2 independently label exact spans/claims/conditions/denominators before tuning; separate holdout and cover RU/EN, long/mixed/code/table, contradiction/versions/tail/no-answer/injection/larger scopes. Execute each declared LOCATE/ASK/BRIEF/COMPARE/HYPOTHESIS_REVIEW/FACT_CHECK/PROJECT_VS_LITERATURE_AUDIT/DEEP/REPORT product against its accepted version. Extend existing testkit adjudication/promotion functions; live adapter must call actual authorized API/model/index, not fabricate results from fixture output.

93.3 record samples/repetitions/corpus/model/prompt/parser/index/build identities and per-product recall, citation validity, support/counterevidence/abstention/coverage, latency/cost when measured. Apply each canonical threshold to its metric, not 'overall accuracy'. Failing collapse/unsupported accepted evidence blocks corresponding promotion. Done means actual authorized measurements, retained failures/uncertainty and rollback target; NOT_EXECUTED is not PASS. This is evaluated-version quality, not universal truth.

## S94 — first full staging · [#286](https://github.com/UnknownAlienHuman/eliot-research/pull/286)

94.1 existing deploy orchestrator/preflight/resource manifest uses explicit approved isolated target, secret references and spend budget; reuse valid prior configuration rather than ask again. 94.2 local wrong-target/missing-binding/partial-migration/stale-asset ordering regressions via `pnpm test:provisioners`, `pnpm cf:types`, `pnpm build`, `pnpm cf:dry-run` and relevant U additions. Future T4/T6 receipts cannot block the staging deployment that enables them.

94.3 authorized actual `pnpm cf:deploy` through existing orchestrator, not raw CLI bypass, then independent Worker tree/version/schema/R2/Queue/DLQ/DO/Workflow/AI/PWA/Wasm readback and Access protection. Done: all identities match tested build/config and unrelated production data untouched. Only then S93/S95/S96. Missing live approval/credential blocks that action only; writing this assignment does not authorize deployment.

## S95 — native conformance · [#287](https://github.com/UnknownAlienHuman/eliot-research/pull/287)

Prepared existing probes, one thin runner, six explicit batches: 95.1 Access/API/MCP/storage readback; 95.2 Queue duplicate/lost-ACK/DLQ and DO eviction/hibernation/cursor; 95.3 native Workflow cancel/recovery and model UNKNOWN settlement; 95.4 active AI Search exact locator/generation; 95.5 selected Workspace action/readback and independent authenticated federation; 95.6 approved disposable purge/restore/code-index rollback.

Runner extension is part of this task where absent, not an already available magic conformance command. Pin target/build/config/time and intended effect identity. ACK-loss injection may discard response, not substitute execution. Native API version/status is checked against pinned runtime; paused and errored differ. Wrong/stale/fake receipt denied; missing input NOT_EXECUTED. Cleanup only probe-owned resources; lawful first audit after saved synthesis allowed, duplicate synthesis not. Complete all applicable actual observations before live qualification.

## S96 — measured workload · [#288](https://github.com/UnknownAlienHuman/eliot-research/pull/288)

96.1 existing workload/probe driver or thin missing adapter implements canonical mix: 5/20/50 readers, 5 interactive sessions, 10 queued jobs, 2 long Workflows. Record corpus/cache/cold-warm/build/duration/sample and approved spend/stop conditions. Do not state a runner exists solely because its plan names one.

96.2 measure read/open, model run, indexing and recovery separately: percentiles/errors/throughput/CPU/heap/queue lag and actual usage, estimates separately from bills. 96.3 bounded overload/cancel/restart/drain and model budget-stop preserving permitted exact reads. Done: applicable repository/profile targets evidenced or concrete failing owning-task regression remains open. No unlimited buffers, blind paid retry, indefinite stress loop or local fixture advertised as a measured live workload.

## S97 — release closeout · [#289](https://github.com/UnknownAlienHuman/eliot-research/pull/289)

97.1 reconcile existing implementation-status/gaps/checklists with actual callers, negative/replay evidence and current generation-specific results for mandatory selected v1 Slices0–6, Rust and S98/S99. No new registry or optional legacy Google/Slice7 scope.

97.2 require S92 actual local, S93 real quality, S94 attested deployment, S95 native/security, S96 measured workload. Changes invalidate only affected evidence; missing behavior cannot close by editing Markdown. Independent reviewers/readback compare artifacts and results, not trust a green status claimed by the implementing agent.

97.3 execute approved canaries source→exact evidence→Research→accepted publication→federation→Workspace→disposable erasure/clean restore plus rollback during agreed observation. Check actual Access/budget, DLQ/overdue erasure and owner approval. Done: existing-format release receipt with exact build/schema/search/Wasm/assets/auth/transport/model/rollback identities and accepted version/profile. This can close the known v1 project scope; it is not a promise that no future defect exists and it does not absorb an unspecified rewrite at the end.
