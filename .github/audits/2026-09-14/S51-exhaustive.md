# S51 — Exhaustively scan the complete frozen scope

Baseline: `a2aca127`; ER-04/07/09/30. Existing exhaustive-workflow-service, durable shards/cursors, cancellation, and status already exist. Complete the missing end-to-end path. Dependency correction: larger logical scope integration is S99/#291; S80 is the separate Rust scope migration.

## 1. Problem

Top-k no-hit does not prove absence. Exhaustive scanning must account for every eligible source/section, including results beyond the first page and matches spanning read boundaries.

## 2. Required change

Connect admitted source → existing outbox/projection → EXHAUSTIVE_JOB → all shards → reconciled denominator → result artifact → status/open. Permit a scoped-absence result only for a complete authoritative scope. Other outcomes retain explicit partial/unknown coverage.

## 3. Documentation and exact search anchors

[Architecture, sections 6.10 and 19.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 6.10. Exhaustive operations' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse immutable scope/shard manifests, cursors, exact R2 scanning, and Workflow checkpoints. Reranking or model output cannot exclude denominator members. Streaming UTF-8/literal scanning retains overlap across ranges, canonical offsets, and deterministic deduplication.

Reconciliation verifies unique expected shard identities, the full source set, omitted/failed shards, and manifest hashes before COMPLETE_SCOPE. Re-delivery of the same verified shard result is idempotent, not an automatic failure; it cannot count twice or stand in for a missing shard. Conflicting results under one shard identity must fail. Assemble large results in R2 and return handles/cursors, not a whole-corpus in-memory response. Check cancellation/currentness between batches. A catalog page is not the full denominator without proved end-of-pagination.

## 5. Acceptance criteria

- [ ] Matches beyond top-k/pages and across UTF-8 range boundaries are found; an independent fixture oracle gives 100% exact all-occurrence recall.
- [ ] Missing or failed shards cannot produce completeness. Identical duplicate delivery is safely deduplicated; conflicting duplicates fail and never inflate counts.
- [ ] Restart/lost ACK converges without duplicate counts; purge/revoke/deadline/cancel cannot produce false absence.
- [ ] Exercise an actually imported corpus through D1/R2/Workflow/API and result readback; record exact SHA/results.
- [ ] Preserve existing schema envelopes; integrate larger scopes through S99 rather than arbitrary limits or waiting for unrelated Rust migration.
