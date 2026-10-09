# Replay and execution identity audit — C12–C18

Checked 2026-10-08 against `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. Continuation of CODE-INTEGRITY-AUDIT.md, not a competing implementation queue. No runtime/SQL/main/Cloudflare changes. Existing #242 owns the retrieval repair; START-HERE governs integration. No issue/discussion comments.

## C12 / P1 — torn ledger snapshot

**CODE:** [investigation-service.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/research/src/investigation-service.ts), `readSnapshot`/`assertContiguous`; [ports.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/research/src/ports.ts), `LEDGER_SQL.selectHead/selectEvents`.

Separate SELECTs can observe head.event_head=1, then an atomic concurrent append, then two events. Reader reports LEDGER_INPUT_INVALID although the database is valid. Reproduced using the exact extracted functions, identity decoder fixtures and SQLite 3.49.1: injected atomic append causes count divergence; subsequent read is coherent at 2/2.

**Repair:** read the immutable prefix `sequence <= pinned head.event_head` with a second bind and retain cardinality/contiguity checks; alternatively return both reads from a single D1 batch. Currentness before later effects remains separate. Do not retry every integrity failure. **DOCS:** distinguish coherent historical snapshot, stale head and corruption. **Acceptance:** correct append does not look corrupt; missing/foreign events still fail. D1 Sessions provide sequential consistency, not a fixed snapshot: https://developers.cloudflare.com/d1/best-practices/read-replication/ . Native batch: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch . No new transaction framework.

## C13 / P1 — request identity is reused as execution/trace identity

**CODE:** [service.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/retrieval/src/service.ts), `createRetrievalQueryService`; [query-persistence.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/retrieval/src/query-persistence.ts), `createD1RetrievalTracePort`, `createD1RetrievalResultStore`.

Trace/pack IDs derive only from raw query/product/literals/limit/scope digest, not invocation. Distinct authorized executions on the same frozen scope can have different observed traces but the same trace PK. INSERT ON CONFLICT DO NOTHING plus exact readback rejects the second trace. Also, service commits trace before result: a result-write failure leaves a trace that can block the retry after retrieval changes.

**Reproduced:** byte-verified full service.ts plus actual extracted persistTrace function and its SQL over a reduced SQLite trace table. Changing lane availability while retaining scope/query caused a collision across different keys. Trace-only partial commit followed by retry left one trace, zero result rows, two errors. Public requests that obtain different snapshots need not hit this case; not every repeated HTTP query fails.

**Repair in R02/#242:** separate request digest, stable scoped invocation identity and output digest. Version new trace/pack IDs; retries do not mint random new IDs. Atomically settle trace and result in D1 batch/command, retaining existing triggers, exact readback and historical codecs. No HTTP/R2/model I/O in the transaction. Never fix by overwriting old trace JSON or silently re-executing a paid request. **DOCS/acceptance:** exact replay vs new execution, generation identity, orphan/partial settlement and changed provider output.

## C14 / P2 — same-key concurrent calls duplicate lane work

**CODE:** service `results.load → execute lanes → results.store`; no in-flight ownership in `RetrievalResultStore`.

Two load misses allow both requests to execute. Reproduction: same key, two successful calls, six fixture lane calls vs three for one request, one result entry. Completed replay correctly avoids further lane calls. This is not measured billing or an exactly-once claim about Cloudflare.

**Repair:** reuse the caller's existing operation/Workflow attempt; define bounded ownership for paid managed calls where required. Process-local Promise dedup is only an optimization, not a cross-isolate guarantee. Do not add the full W2/W3 ledger to every harmless read. **DOCS:** state whether concurrent joining, in-progress conflict or duplicate read-only work is allowed. Unknown external outcome plus expired lease is not permission to resend.

## C15 / P1 — known typed errors become retryable uncertainty

**CODE:** service catches around `results.load`, `persistTrace`, `results.store` erase domain error and cause.

Actual module execution mapped nonretryable RETRIEVAL_SCOPE_STALE, RETRIEVAL_AUTHORITY_STALE and RETRIEVAL_IDEMPOTENCY_CONFLICT to retryable RETRIEVAL_RESOLUTION_UNCERTAIN. Underlying store already distinguishes these cases.

**Repair:** preserve existing RetrievalQueryError unchanged; translate only unknown I/O. Retain sanitized internal cause, not raw SQL/secrets in public messages. **DOCS:** [failure-model.md](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/implementation/failure-model.md) already prohibits catch-all retry of policy/schema/integrity/stale failures; bring CODE into compliance. **Acceptance:** typed code/retryability survives, ordinary transport uncertainty remains, message-string spoofing is not trusted.

## C16 / P2 — copied error handling throws on null/undefined

**CODE:** service catch; [lanes.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/retrieval/src/lanes.ts) `executePlannedLanes` and `createSemLaneExecutor`: `(error as {code?: unknown}).code`.

The service reproduction throws TypeError for `throw null` and `throw undefined`, instead of recording LANE_EXECUTION_FAILED. Other copies have the same unsafe access.

**Repair:** a small shared unknown-value code reader with object/null/type checks in the existing lane implementation. Keep authority/cancellation short-circuiting, do not turn it into an ordinary omission. Do not introduce a universal error framework. **Acceptance:** null/undefined/string/Error/domain errors retain intended outcomes.

## C17 / P2 — globally shared raw Research idempotency keys

**CODE:** [research-session.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-core/src/research-session.ts), `createResearchRunService.run`; ledger `readByIdempotency`; [0069](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/infra/d1/core/migrations/0069_research_question_envelopes.sql).

Run ID includes principal, but lookup and UNIQUE use the raw header alone. Another principal using the same key gets RESEARCH_CONFLICT. Principal checks prevent foreign result disclosure; this is namespace interference, not a demonstrated authorization bypass. The corresponding UNIQUE collision was reproduced on a reduced SQLite schema; public auth flow was read, not executed.

**Repair:** version the server-scoped invocation key and update every lookup/constraint/dispatch association consistently. Keep request digest separate so same actor/key/different payload conflicts. Existing `createD1RetrievalResultStore` is an internal scoped-identity donor, but do not copy credential-generation inclusion blindly: rotation must not implicitly authorize repeat billing. Preserve historical raw-key records and replay. **DOCS:** key scope, rotation, conflict and legacy behavior in run-request/#233 and failure model.

## C18 / P3 — duplicate B-tree for idempotency_key

0069 recreates `idempotency_key ... UNIQUE` and an ordinary `investigation_ledger_idempotency_idx` on the same column. The reduced SQLite schema produces both the UNIQUE autoindex and named nonunique index. After dropping only the latter, EXPLAIN QUERY PLAN still uses the UNIQUE autoindex for lookup.

**Repair:** inspect current schema and INDEXED BY dependencies; a new migration may drop the redundant named index, never edit historical migrations or remove UNIQUE. Coordinate with C17's final namespace/index design to avoid an unnecessary intermediate migration. No production savings or complete deployed-schema qualification claimed.

## Additional observations and exclusions

- Revalidated, not new: `laneCandidateIds` is a write-only Set in service. Remove during lane cleanup, not as a standalone cosmetic PR.
- `readSnapshot` always reads full history, including head-only callers. Consider a head-only method and pinned/paginated history after preserving integrity boundaries; no production latency benchmark.
- Public stored-query replay DOES recheck scope/profile/delegation/abort in `readStoredResearchQueryExecutionResult`; do not report an authorization bypass based only on the generic service's early return.
- Exports, historical codecs and deployed DO classes are not proven dead by an empty indexed search. Full repository call graph was not produced.

## Evidence and status

Full service source Git blob verified: `e6d7264e462108e09615a73f385f72c9e187a15e`. Source functions for trace/ledger are copied excerpts. Node 22.16.0, TypeScript 5.8.3 transpilation, SQLite 3.49.1; contracts/planner/empty-fusion/access/result-store dependencies are explicit fixtures. No repository-pinned typecheck, Vitest, ESLint, full migrations, workerd, live D1/R2, browser, model or cost qualification. Archive DNS failed; connector reads supplied the source.

The standalone Russian report and reproduction archive carry further detail. This card is documentation only; no fixed-runtime, production readiness or historical 11/18 root-cause claim. Implementation gates remain scoped compilation/lint and SQL depth-100 where applicable, with final behavioral/native acceptance after assembly.
