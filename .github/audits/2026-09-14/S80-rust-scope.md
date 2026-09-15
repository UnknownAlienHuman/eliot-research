# S80 — Port scope algebra and currentness to Rust

Baseline `a2aca127`; ER-30/02/40. Reuse existing scope identity parity, S78/#270, and accepted #200/#202/#225 semantics. Target: eliotr-scope; D1 enumeration and grant writes remain TypeScript responsibilities.

## 1. Problem

K2a verifies snapshot identity serialization, not algebra, membership resolution, or authorization currentness. Repairing JWT continuity must not expand a frozen source scope.

## 2. Required change

Port pure UNION/INTERSECT/EXCEPT normalization, ordered membership resolution, and comparison of explicit currentness facts. Inputs contain atom/revision/ownership/policy-closure/purge observations and time; outputs contain typed members/digests/denials, without DB access.

## 3. Documentation and exact search anchors

[Launch09](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md); [Language contract 5/8.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'K3.scope algebra/snapshot' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Implementation approach

Reuse admitted scope schemas and vectors. Global/project/source atoms require explicit authorization observations. Take duplicate handling and canonical order from accepted domain rules, not incidental SQL row order. Sharding and serialization limits must not silently discard members.

Keep historical-read currentness distinct from active-execution authorization according to accepted #197/#198/#199/#225 contracts. Check all participating atoms before issuing a scope and preserve original frozen source references. Snapshot/grant lifetime management and final transactional authority checks remain in TS/D1. Pure inputs use explicit time and contain no hidden platform handles.

## 5. Acceptance criteria

- [ ] TS/native/Wasm agree on nested algebra, empty sets, duplicate/permuted inputs, shared sources, forbidden atoms, membership/policy/purge changes, and historical scopes.
- [ ] Changed scope under the same request identity conflicts; unknown or partial membership never becomes complete coverage.
- [ ] Algebra properties and EXCEPT/intersection/security-closure mutations detect regressions.
- [ ] No I/O, hidden clock, or unbounded corpus loading; applicable Rust checks pass.
- [ ] Record exact functions, fixtures, SHAs, and results. Actual caller promotion and D1 integration are verified under S89, not claimed by the pure port alone.
