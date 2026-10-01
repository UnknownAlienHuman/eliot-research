# S84 — Port exact-evidence and coverage invariants to Rust

Baseline `a2aca127`; ER-07/10/39/40. Targets eliotr-evidence/eliotr-coverage; identity/scope prerequisites #270/#272. Real R2 reads and current authorization remain TS adapter responsibilities. Evidence and coverage are separate pure-family checkpoints within this task.

## 1. Problem

A search result is a locator, not proof. Migration must preserve exact admitted-byte binding and the distinction between complete, sampled, and unknown denominators. Honest INCOMPLETE_COVERAGE must not be changed to success merely to pass a test.

## 2. Required change

Port pure resolution invariants for revision/owner/scope/purge/map/range/length/digest and deterministic coverage/absence/disposition decisions over verified observations. Do not port resolver I/O or allow the model to invent citation IDs.

## 3. Documentation and exact search anchors

[Architecture 6.10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md).
```sh
git grep -n -F 'Only `NO_MATCH_IN_COMPLETE_SCOPE` permits a scoped absence claim.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Use existing handle/coverage schemas and accepted TS behavior as the reference until promotion. TS performs actual reads/currentness checks and supplies validated observations, not client-supplied success booleans. Preserve eligible/represented/cited/omitted sets, source families, independence, and failed/skipped lanes.

An exhaustive absence claim requires a reconciled complete denominator. Sampled no-hit, a supported narrow answer, and complete absence are different outcomes: unknown coverage does not automatically forbid every narrow supported answer. Keep all nine CompletionDisposition values. Recheck retention/purge in the adapter before disclosure.

Duplicate-delivery clarification: an identical retry is deduplicated and must not increase counts; a conflicting duplicate fails. An extra receipt cannot substitute for a missing shard. Receiving an identical duplicate alone must not invalidate an otherwise complete reconciled result.

## 5. Acceptance criteria

- [ ] TS/native/Wasm agree on exact Unicode/table/range positives and corrupt, foreign, stale, and purged negatives.
- [ ] Missing/conflicting shards, omitted members, unknown denominators, and duplicated source families cannot establish false completeness or independence; identical replay remains idempotent.
- [ ] Hash/range/count/denominator mutations are detected without weakening accepted-citation invariants.
- [ ] Actual resolver/exhaustive regressions #240/#243 remain valid; retain pure Rust gates, shared fixtures, exact SHAs, and results.
- [ ] S88/S89 separately establish actual shadow/promotion. Pure fixtures do not prove production operation.
