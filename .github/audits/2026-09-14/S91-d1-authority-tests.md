# S91 — Eight actual-D1 transaction batches with explicit test entries

Baseline a2aca127; F14/F15/F16, ER-13/27. S04 owns the focused project/Wiki-edit regressions. This task integrates the remaining named transaction families, not another test framework. Each row is independently implementable; an already sufficient actual-runtime case is reused, not copied.

## 1. Problem

Migration compilation, root Vitest or DatabaseSync do not prove that actual D1 executes a service's guarded operation. The earlier command table named ten scripts absent from package.json. This replacement gives real test paths and expressly marks future test additions.

## 2. Required change

For batches 91.1–91.8 call the actual service against CORE_DB/SEARCH_DB/R2 in the core Cloudflare test runtime, verify commit/readback plus rejection/replay/race. Preserve production SQL guards and immutable migration history. A core-directory test that substitutes a SQLite DB or stubs the application result is not accepted merely because it ran in W.

## 3. Documentation and executable commands

[Language §7 SQL authority](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [root package scripts](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/package.json), core vitest.config.ts and tracked core test directory.

Run from repository root, choosing exactly a row's files:

```sh
pnpm --dir apps/eliotr-core exec vitest run test/model-attempt-store.test.ts test/model-attempt-handler.test.ts
pnpm typecheck
```

For final combined local runtime coverage: `pnpm --dir apps/eliotr-core exec vitest run`. This is separate from root `pnpm exec vitest run`; root `pnpm test` DOES chain both root and core tests, as well as provisioner tests. Do not confuse the root Vitest command with the package test script. Existing `check:affected` is the full check, not a --base-aware selector.

## 4. Closed batch entries

Paths in the last column are relative to apps/eliotr-core and appended to the W command above. NEW means add the missing regression in the stated location or reuse an already introduced equivalent by the linked task, recording the exact replacement path. It never means run a nonexistent file or count zero tests as success.

| Batch | Service/authority operations that must be exercised | Existing test entry points; required new integration where absent |
|---|---|---|
| 91.1 intake/ownership/grants | Normalized bundle prepare/complete/promote; SourceAdmission guarded commit; ownership/cutover; project-client grant issuance/revoke; append-only attachment. | test/bundle-import-http.test.ts, test/ingest-service.test.ts, test/source-admission-service.test.ts, test/ingest-promotion-authorization.test.ts, test/source-revisions.test.ts. NEW from S04/S10/S31/S70/S98: test/project-owner-mutation-d1.test.ts, test/project-client-grants.test.ts, test/project-client-auth-http.test.ts, test/source-owner-cutover-d1.test.ts, test/machine-ingest-project-roundtrip.test.ts. |
| 91.2 scope/currentness | Scope expression resolution/freeze/persist; held-scope authorization; historical read and same-operation execution renewal; larger scope metadata. | test/scope-service.test.ts, test/scope-persistence.test.ts, test/research-held-scope.test.ts, test/orientation-http.test.ts. NEW from S99: test/research-large-project-history.test.ts; S06/S33 extend these existing held-scope/status cases. |
| 91.3 W1/W2 | W1 CREATE/APPEND/CHECKPOINT/supersession masks and CAS; W2 stage begin/settle/recover/cancel, head and receipt bindings. | test/investigation-ledger-d1.test.ts, test/investigation-ledger-commands-d1.test.ts, test/research-workflow.test.ts, test/research-workflow-recovery.test.ts, test/research-session.test.ts, test/research-run-status.test.ts. NEW from S36/S40: test/research-planning-manifest.test.ts, test/research-reopen.test.ts. |
| 91.4 W3/model | Model attempt/reservation/lease/output settlement; fingerprint/pricing observations; validation before retry; runtime deployment/proof binding. | test/model-attempt-store.test.ts, test/model-attempt-handler.test.ts, test/research-model-fingerprint-store.test.ts, test/research-model-pricing-store.test.ts, test/research-model-output-store.test.ts, test/research-model-attempt-revalidator.test.ts, test/research-model-stage-handler.test.ts, test/model-deployment-registry.test.ts. NEW from S34: test/research-proof-renewal-http.test.ts. |
| 91.5 delivery | Outbox dispatch/reconciliation, consumer inbox settlement and lease fencing, poison/DLQ replay after corrected cause. | test/outbox-reconciler.test.ts. NEW S64: test/queue-delivery-replay.test.ts calls actual local producer/consumer/storage; helper-only dispatcher tests do not replace it. |
| 91.6 projection activation | Source revision→channel projection/readiness; complete shadow generation→serving CAS; rollback preserving current purge. | test/retrieval-generation-fences.test.ts, test/library-readiness.test.ts, test/research-query-sem.test.ts. NEW S52: test/index-generation-promotion.test.ts verifies actual generation writes and serving readback. |
| 91.7 artifacts/dependencies | Exact evidence/freeze/report admission; artifact draft/revision/head commit; Wiki publication; derived dependency/change settlement and cursor replay. | test/research-reference-manifest.test.ts, test/research-evidence-freeze.test.ts, test/research-report-admission.test.ts, test/artifact-draft-store.test.ts, test/artifact-draft-reader.test.ts, test/wiki-publication-store.test.ts, test/wiki-service.test.ts, test/research-changes.test.ts. NEW S04/S53–S55: test/wiki-owner-edit-mutation-d1.test.ts, test/artifact-cow-compile.test.ts, test/report-publication-barrier.test.ts, test/derived-dependency-replay.test.ts. |
| 91.8 purge/backup | Erasure permission/case/producer fence/closure/hold; coherent backup cut, nonce and replay authority; isolated restore readiness with current purge. | test/erasure-admission-policy.test.ts, test/erasure-coordinator.test.ts, test/erasure-runtime.test.ts. NEW S63/S65/S66: test/erasure-derived-closure.test.ts, test/backup-source-ports-d1.test.ts, test/backup-isolated-restore.test.ts. Existing O2 DatabaseSync tests remain pure/unit evidence, not D1 proof. |

Existing supplemental scripts, selected by row: `pnpm contracts:check` (strict fixtures), `pnpm ingest:check` (91.1), `pnpm delivery:check` (91.5), `pnpm projection:check` (91.6), `pnpm evidence:check` (91.7), `pnpm erasure:check` (91.8). They supplement actual service execution. Do not manufacture research/authority/workflow/recovery/artifact/backup command aliases.

### One transaction oracle per named operation

1. Apply current migrations through the existing core setup; use fixture builders for valid prerequisites, never a forged success receipt. Record canonical row/head/receipt/outbox state before invoking the real service.
2. Execute valid input; read exact resulting row identities/hashes and required external immutable bytes. HTTP 200 or SQL change count alone is insufficient.
3. Replay the same input/key; vary expected revision, input digest, principal, policy/purge state and lease where relevant. Inject concurrent winner, effect-before-lost-ACK and restart. Completed work returns its existing durable result; uncertain outcome is reconciled, not retried blindly.
4. Rejection leaves no partial authority head/receipt/outbox. A late revoke before final disclosure/commit remains effective. Existing protected W1 masks and SQL CAS cannot be removed to get green tests.
5. Exercise admitted structural maximum and D1 depth/binding/batch limits. Verify both clean migration chain and upgrade from the supported previous schema. Partial migration/readiness failure never becomes a functioning target. Never edit an already merged migration.
6. Record operation→service→exact test→result and implementing SHA within the original task; move to the next row. Any added authority writer in S01–S99 belongs to its listed row and must add its positive/negative case before that feature is accepted. This is a bounded test-accounting requirement, not another registry or broad audit exercise.

Structural JSON validation may be shared outside SQL only when final identity/policy/purge/immutability/currentness remain atomic. A weak SQL predicate is not automatically a reachable normal-API exploit: show actual writer/readback behavior before changing guards.

## 5. Acceptance criteria

- [ ] Every named operation in rows 91.1–91.8 has actual D1 commit/readback, rejection and applicable concurrent/replay evidence; existing sufficient tests are reused and NEW paths are implemented before invocation.
- [ ] No partial head/receipt/outbox or duplicate completed model effect after rejection/UNKNOWN recovery. Legitimate first AUDIT after saved synthesis is not incorrectly banned.
- [ ] D1 resource/shape failures are observed locally; DatabaseSync, copied SQL, empty test selection and migration compile-only cannot count as PASS.
- [ ] Focused row tests and final core-runtime suite pass on applicable CI platforms; pure tests and real package commands remain unchanged unless their own justified task changes them.
- [ ] Eight row results retain exact services/test paths/SHAs/commands/results. Completion of one representative example cannot close a whole family; local acceptance still does not claim native T4/T5 success.
