# S91 — Verify active authority transaction families on actual D1

Baseline `a2aca127`; F14/F15/F16, ER-13/27. S04/#196 covers Project/Wiki. This is an aggregate integration-coverage task for remaining active transaction families, not one small application change and not a wholesale replacement of useful pure SQLite tests.

## 1. Problem

node:sqlite unit tests do not establish D1 runtime compatibility. Applying a schema successfully does not prove that the first real INSERT/UPDATE and its triggers will execute correctly.

## 2. Required change

Use the existing Workers harness to cover actual service transactions for ingest/admission/grants, scope/currentness, outbox/inbox, W1/W2/W3, index promotion, publication/dependencies, erasure, and backup. Reuse existing packet tests and real-D1 coverage rather than introducing another test platform.

## 3. Documentation and exact search anchors

[Language contract section 7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md); [Execution contract section 4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F '## 7. SQL authority contract' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```

## 4. Implementation approach

Map each public mutating service to its emitted SQL family and existing test. Retain tests already executing under workerd-D1. For missing coverage, apply the real migration chain, invoke actual services, and compare canonical rows/heads/outbox before and after. Cover fresh databases and upgrades from supported previous schemas; never rewrite merged migration history.

Negatives include malformed/unknown shapes, stale CAS, competing writers, lost acknowledgement/readback, policy/purge races, and maximum admitted payloads against D1 expression/binding/batch behavior. Do not copy application SQL into the test. Simplify repeated structural JSON checks only where they are not atomic authorization invariants; preserve final identity/revision/policy/purge/immutability guards. Predicate mismatch alone is not a proven API exploit: demonstrate supported-writer reachability, as in #217.

## 5. Acceptance criteria

- [ ] Every active family has actual-D1 successful commit and negative rollback coverage; missing families are named, not hidden.
- [ ] Depth, parameter, and batch failures are detected before deployment; the test does not substitute DatabaseSync for D1.
- [ ] Partial/malformed migrations do not yield readiness; retry/lost-ACK settlement does not duplicate writes.
- [ ] Retain fast pure tests and applicable Linux/Windows runtime suites. Record exact SHA, commands/results, and family→service→test mapping.
- [ ] Migration compilation alone is not completion; close this aggregate only after all applicable family checkpoints have passed.
