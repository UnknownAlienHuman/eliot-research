# S91 — Eight explicit actual-D1 transaction batches

Baseline `a2aca127`; F14/F15/F16, ER-13/27. S04 already covers Project/Wiki owner-edit regressions. The eight batches below complete remaining runtime coverage without replacing useful pure unit tests or introducing another harness. Each batch is a separate reviewable test/change checkpoint; the original PR records their final combined result.

## 1. Problem

Root Vitest and node:sqlite fixtures do not prove that actual D1 executes a service's INSERT/UPDATE, triggers, bindings and batch behavior. Successful migration compilation is not transaction acceptance.

## 2. Required change

For each listed batch, execute the actual production service with current local D1 migrations, preserve existing real-runtime tests, and add only missing positive/negative/replay cases. Use the existing core Workers test configuration; do not copy emitted SQL into a more permissive fake adapter.

## 3. Documentation and exact runtime

[Language §7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [actual core configuration](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/vitest.config.ts), [root configuration](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/vitest.config.ts).

```sh
git grep -n -F '## 7. SQL authority contract' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
pnpm --dir apps/eliotr-core exec vitest run
```

During development add the specific test path to that command. The root test include pattern does not include core tests. The core configuration loads CORE_MIGRATIONS/SEARCH_MIGRATIONS and the local `env.test`; no cloud deployment is required for these batches.

## 4. Batches, starting points, and one common oracle

| Batch | Actual family/starting point | Relevant existing command |
|---|---|---|
| 91.1 | core ingest/admission, owner/cutover adapters, S10/S31 project grants | ingest:check, owner:check, authority:check |
| 91.2 | cloudflare-navigation scope-service/d1-scope-service, profile/currentness/reauthorization | source:check, retrieval:check |
| 91.3 | research/src/ledger-commands.ts, investigation-service.ts, core ResearchWorkflow/W2 | research:check, workflow:check |
| 91.4 | cloudflare-research model-attempt-store.ts, spend-admission and recovery callers/W3 | model:admission:check, recovery:check |
| 91.5 | existing outbox/inbox/lease/consumer/reconciliation stores | delivery:check, recovery:check |
| 91.6 | S52 serving/shadow generation stores and expected-head promotion | retrieval:check, source:check |
| 91.7 | current artifact/Wiki publication and dependency-manifest settlement | artifact:check, research:check |
| 91.8 | current purge/closure/hold coordinator and backup O2 nonce/replay authority | erasure:check, backup:check, recovery:check |

Prefix commands with `pnpm`. They supplement, not replace, the actual service tests in the Workers configuration.

For each batch perform exactly this sequence:

1. Reuse an existing actual-D1 test if present; otherwise add one focused file under `apps/eliotr-core/test/`. Construct valid inputs via existing fixture builders and real supported service operations, not by inserting a fake success receipt.
2. Record pre-state (canonical rows/heads, receipts and outbox), invoke one legal operation, then read back exact resulting state. Do not treat change count or HTTP success alone as proof.
3. Repeat identical input/key and inject stale expected revision, malformed/unknown input, competing writer, lost ACK and in-flight permission/purge change where that service has external work. The correct winner/replay result remains stable; failed operations leave no partial authority writes.
4. Test the maximum admitted structural input and the D1 expression/binding/batch boundary. An oversized SQL statement must fail locally rather than appear only after deployment. Include fresh database and upgrade from the supported previous schema; preserve merged migrations unchanged.
5. Run the batch's existing domain/contract command and actual Workers regression, record service→test→result and implementing SHA, then proceed to the next batch. Do not rerun every unrelated suite after each small test edit.

Fix a demonstrated SQL structural duplication only together with its supported writer/readback regression. Final identity, revision, policy, purge, immutable-event and terminal-state constraints remain atomic. W1 CHECKPOINT must still reject a protected portfolio/debt mutation. A weaker SQL shape check alone is not proof that the supported API can write an unreadable row.

## 5. Acceptance criteria

- [ ] Batches 91.1–91.8 each have actual service commit/readback and appropriate rejected/concurrent/replay cases; previously sufficient real-D1 tests are reused, not duplicated.
- [ ] Refusal and uncertain-settlement recovery do not leave partial heads/receipts/outbox or duplicate canonical effects.
- [ ] Actual D1 depth/binding/batch limits and partial-migration readiness failures are caught locally. No DatabaseSync substitution or compile-only acceptance.
- [ ] Existing pure fixtures remain useful and green; final applicable Windows/Linux core-runtime suites pass with exact commands/results.
- [ ] The original PR contains eight explicit batch results and SHAs. A completed first batch cannot close the aggregate, and missing coverage is not filled by another general audit document.
