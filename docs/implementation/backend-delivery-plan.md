# Backend delivery plan

Baseline: `ddf5979b64e2da8b611715271b5358b18cc4427f`. Work directly in current `main`; no worktrees, wholesale merges of planning branches, or unrequested cloud deployments. The owner requested implementation of the difficult domain/control-plane work, with broad testing, UI polish and mechanical cleanup delegated to the local agent.

The existing [99-task index](https://github.com/UnknownAlienHuman/eliot-research/pull/292) remains the requirement map. This document is the implementation order and handoff, not a replacement backlog. The supplied consolidated audit is evidence to verify, not permission to remove policy, evidence, Budget Governor or atomic SQL protections indiscriminately.

## Implementation order

1. **Operation identity and lifetime — S08, S16, S14/S15, S05/S33.** Fix replay binding before widening access or extending run lifetime. Preserve durable cancellation and terminal-state ordering before adding more model branches. Then separate compatible deployments and server execution authority from browser-session lifetime. Existing S06 historical read reauthorization is retained. No stored result, receipt, source revision or operation identity is rewritten to make a check pass.
2. **One delegated machine principal — S10/S31, S11/S12/S13, S98/S99.** One owner-issued project grant and exact operation vocabulary. Wire the real HTTP/MCP request path, normalized intake, append-only project attachment and complete authorized scope. Never impersonate `owner_pwa` or use a browser token as machine identity.
3. **Executable Research — S09/S21/S22, S35–S46.** Connect managed retrieval to the real Workflow first. Implement protocol/planning/freeze/debt/verifier decisions and one shared checkpointed branch executor. No role-specific engines, unconditional model fan-out, or technical checkpoint counted as a scientific procedure.
4. **Persisted products and integrations — S47–S61.** Complete admission/navigation/index generation boundaries, compiler/publication/dependency decisions and the selected Workspace/federation paths. Reuse existing converters, exact evidence resolver and managed Cloudflare services.
5. **Data and execution safety — S62–S72.** Complete erasure closure, delivery reconciliation, coherent backup/isolated restore, rollback, bounded Steward and event/currentness behavior. External parameters are needed only for the corresponding actual live action, not to write the code.
6. **Single deterministic runtime owner — S78–S89.** Port only stabilized domain families, retain exact legacy bytes, prove one actual Wasm boundary, then switch one caller family at a time and remove its replaced TS implementation. Do not freeze an unfixed TS bug as normative parity.

Within each phase, an existing dependency is reused rather than rewritten. Independent wiring fixes may precede a larger migration when they are needed to exercise the same real path. A task is not closed because its Markdown was merged or one helper compiled.

## Division of work

**This implementation:** domain decisions, strict request binding, authorization/currentness, transactional settlement, real application composition, and narrow regressions needed to establish that the critical change is safe. Record the actual result, not an anticipated PASS.

**Local agent:** full Linux/Windows/core/browser suites, fixture expansion, mutation/load/quality/native-platform qualification, UI tasks S19/S20/S26/S73–S76, source-budget/documentation cleanup, and final S92–S97 acceptance. Do not replace real D1 tests with DatabaseSync or change assertions merely to get green output. Existing commands and proof boundaries are in PR #292.

Paid-effect/authentication/cancellation changes still need a focused negative/replay test before push. The owner's delegation of broad testing is not a waiver of correctness or permission to disable safeguards.

## Checkpoint ledger

- **Already on the baseline:** S01 boundary repair and S06 historical reading. Their earlier focused results are recorded in PRs #193 and #198; full/live acceptance is separate.
- **Implemented, code commit [e15afeee](https://github.com/UnknownAlienHuman/eliot-research/commit/e15afeeec65b8e3304abc3cb802e1fbbab52ed60): S08 replay.** Compare normalized requested scope against the original persisted expression before returning cached bytes. Equivalent redundant expressions replay; changed PROJECT/GLOBAL/SELECTED expression conflicts even when current members happen to match. Preserve old result digests and recheck currentness after asynchronous hashing; no replacement snapshot or new authority writes.
- **Implemented in the same checkpoint: S16 internal DO terminal settlement.** A missing or failed canonical D1 cancel cannot produce a successful CANCELLED response. Verify the actual cancellation receipt, then update the short-lived DO projection in a storage-only transaction. A stale execute snapshot cannot overwrite another terminal state. Confirm canonical completion before projecting it. This does not implement the separate public S14 cancel endpoint or S15 native recovery API.
- **Implemented in the same checkpoint: S09 versioned semantic retrieval.** Passing AI_SEARCH was necessary but not sufficient: FAST_SEARCH's plan does not run SEM. New exploratory runs select `research-handlers.exploratory.v4` and the existing RESEARCH retrieval plan. Existing v1/v2/v3 runs retain their old behavior and immutable receipts. Carry AI_SEARCH through environment and explicit-dependency factories and the real semantic server. Read the stored generation for status, materialization and recovery; v3/v4 share the existing synthesis/audit/citation/coverage machinery without rewriting old results. Missing managed binding remains an explicit skipped lane, not a claimed semantic success.
- **Implemented, code commit [be4d147](https://github.com/UnknownAlienHuman/eliot-research/commit/be4d147053833d808a3e3ebad5377b3b036b8bdc): S14 public cancellation.** The strict owner-only POST run/cancel route returns the existing status and deterministic W2 cancellation receipt only after canonical readback. Current owner authorization uses the original frozen source set without impersonating its original credential. Existing authority epochs and current grant/deadline predicates fence the conditional SQL write; completion-first conflicts, failed or lost acknowledgements reconcile against the same run, and late stage output cannot commit after cancellation. Native termination is attempted only after confirmed cancellation and its failure cannot undo that decision. No new ledger, migration, replacement run or model call.
- **Implemented on the current checkpoint: S15 public recovery.** The strict owner-only POST run/recover route operates on the same Workflow instance and records one durable recovery action per run/stage. Active/completed runs do not mutate. Paused instances resume; errored/terminated instances restart once, from the current step when an attempt exists. Lost native acknowledgement is reconciled by status without another restart. Existing W2 attempts keep their original spend identity: unexpired attempts still pass the ordinary Budget Governor, while an expired reservation can settle only after the exact owner-authorized recovery action is present in D1. Recovery invokes registered deterministic/readback adapters only; the paid handler is never called again. VERIFY recovery rereads exact synthesis bytes and does not repeat synthesis. Unknown provider effects, cancellation, revocation and corrupt state remain closed.
- **Implemented on the current checkpoint: S05 bounded deployment compatibility.** Exact deployment generation remains immutable provenance, while the single ACTIVE Worker may continue a run only when the origin and active generations have the same reproducible backend fingerprint. The fingerprint covers tracked backend/application/domain/Rust/D1 bytes plus scrubbed generated binding/configuration topology; it excludes PWA assets, documentation, build time and the substituted deployment generation. Legacy rows without evidence remain compatible only with themselves while ACTIVE. Unknown handler/schema/resource/config changes remain blocked; old receipts and source revisions are not rewritten. Deployment synchronization refuses an incompatible retired target before retiring the current generation, and the deployment receipt records the reviewed fingerprint/readback without exposing secrets.
- **Next key work:** operation-bound long-run authority (S33), then the one delegated-machine grant (S10/S31). S14/S15 currently authorize owners only; service delegation and PWA/MCP controls are separate S10/S32 work. S05 permits only identical-backend/PWA-only continuation and does not authorize arbitrary backend upgrades, rollback, browser-grant renewal or live native lifecycle qualification.

### Retained verification for e15afeee

[Clean-checkout validation and direct-main publication run](https://github.com/UnknownAlienHuman/eliot-research/actions/runs/35053788872), artifact `backend-checkpoint-validation`:

- Core and PWA declaration builds, core test typecheck, changed-file ESLint, package boundaries and work-packet ownership passed.
- `research-retrieve-branches.test.ts`: 8 passed; `research-workflow-recovery.test.ts`: 8 passed; `research-run-status.test.ts`: 14 passed. Aggregate: **30/30**, no skipped tests in these three files.
- Separately selected S08 regression in `research-query-retrieval.test.ts`: **1 passed**, 9 other tests not selected. This is not a claim that the entire query-retrieval file passes.
- Actual local D1/R2/DO and persisted W1/W2/W3 are exercised. External model/search responses are controlled. Both v3 and v4 synthesized/audited/materialized report fixtures reopen after login with their original bytes and one synthesis plus one audit; reading does not pay again.
- Source before/after hashes were checked for exactly the 14 changed files before applying and publishing the patch. No migration, fixture normalization, dependency/lock change or cloud deployment was needed.

The first clean-checkout attempt stopped before tests because the test project imports PWA declarations that had not been built. The corrected invocation builds both core and PWA references before checking the core test project; it does not suppress TypeScript errors or change the reviewed application patch. The temporary source/dependency/publication workflow was removed after the verified code push; it is not permanent application infrastructure.

### Retained verification for S14 / be4d147

- Actual local HTTP/application/workerd-D1/R2 paths: `research-run-status.test.ts` **24 passed** and `research-workflow-recovery.test.ts` **8 passed**, total **32/32**. Ten new cancellation scenarios exercise refreshed JWT, completion-first, concurrent callers, revoke immediately before SQL, failed/lost-ACK writes, native failure, malformed/foreign/expired/CSRF requests and late in-flight output. Access verification responses and native instance termination are controlled external boundaries, not live platform evidence.
- Core/PWA declaration builds, core-test TypeScript, changed-file ESLint, package boundaries, work-packet synchronization and implementation registry checks passed. The full browser/Rust/quality/load and deployed suites were not run in this checkpoint.
- Native Workflow termination and machine/UI controls remain separate acceptance. Do not claim an already dispatched provider call was physically stopped: canonical cancellation prevents subsequent stage/publication effects. Original execution credential, source versions and committed receipts remain immutable.
- Commands: `node node_modules/typescript/bin/tsc -b apps/eliotr-core/tsconfig.json apps/eliotr-pwa/tsconfig.json --pretty false`; then `node node_modules/typescript/bin/tsc -p apps/eliotr-core/test/tsconfig.json --pretty false`. From `apps/eliotr-core`: `node ../../node_modules/vitest/vitest.mjs run test/research-run-status.test.ts test/research-workflow-recovery.test.ts`. These invoke the repository's frozen dependencies directly in the offline environment; no lockfile or dependency change was needed.

### Retained verification for S05

- `research-backend-fingerprint` and deployment-authority unit scripts passed, including A→B→A, changed bindings/code, dirty-tree refusal, incompatible retired-target refusal and preservation of the existing ACTIVE deployment.
- Deployment ordering/orchestration/verification scripts passed: **5 + 10 + 11 groups**. Receipt schema accepts additive fingerprint/authority fields while preserving pre-existing receipt compatibility. No live deployment was executed.
- Workerd-D1 deployment compatibility tests passed **2/2**. The focused completed-history/PWA-only status regressions passed during implementation; broad status/Workflow suites remain delegated because the local Miniflare harness retains existing lifecycle warnings and long-lived promises.
- Core/PWA and core-test TypeScript, changed-file ESLint, package boundaries, work-packet ownership and `git diff --check` passed before the checkpoint commit. The new migration preserves the original W2 current-view columns and ledger revision semantics; only deployment-currentness is replaced by the equal-fingerprint compatibility view.

### Concrete local-agent handoff

1. Run the full baseline-relative suites and distinguish inherited failures from new regressions. The aggregate checks above are not a full CI/Rust/browser acceptance.
2. `research-session.test.ts` contains a legacy fixture expecting successful cancellation without an actual W2 run. Create valid canonical W2 authority for its success case and retain a separate missing-run refusal. Never restore best-effort cancellation to satisfy that fixture.
3. Inspect existing query no-hit/selected-document-fallback expectations against the real product behavior; the targeted S08 pass does not resolve their pre-existing mismatch. Do not merely remove assertions or skip the file.
4. Expand SEM tests with representative tail-only evidence, outage, foreign/purged hits and native configured bindings. The new controlled test proves binding propagation, lane selection, exact readback and replay, not live recall or full-corpus quality. Keep v3 compatibility tests alongside v4.
5. Native Workflow warnings in the focused fixtures (`Engine was never started` / `instance.not_found`) and missing env.test AI binding warnings were retained in the logs, not hidden. Resolve their fixture/native-observation setup during full acceptance without configuring real paid providers for deterministic tests.
6. Complete the existing UI and documentation/source-budget tasks separately. S05/S33/S10, S99 large scope and real provider qualification remain actual implementation/acceptance work, not test-only cleanup.

## Completion boundary

The target is the known mandatory v1/Slices 0–6 with `gemini-mcp`. Completion requires both implemented paths and the existing final acceptance in S92–S97. Do not label every PR complete after a code-only pass. Preserve explicit pending live configuration, independent client, offsite destination and release approval requirements; do not fabricate credentials or receipts.


### S10 / S31 grant-backend checkpoint

The current implementation adds owner project-client grant GET/PUT/DELETE plus the shared
project-scoped HTTP/service-token MCP catalog path. Grant records contain no secrets; configured
is not a verified connection. Migration 0072 and the common strict DTO are shared by future
query/run/import consumers. Those consumers remain to implement. Connections now manages
grants through the existing API and provides the independent opt-in service catalog-read command
(`scripts/check-project-client.mjs --help`). Configured is not connected: the PWA does not claim
a signed client round trip from owner readback or the unrelated generic MCP diagnostic.
A supplied spend-policy reference fails explicitly until sponsorship is composed.
Native/behavioral acceptance remains pending; this code-first checkpoint does not claim it.
