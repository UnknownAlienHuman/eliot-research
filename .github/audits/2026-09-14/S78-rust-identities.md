# S78 — Six finite M2 identity checkpoints

Baseline `a2aca127`; F26, ER-40/01/00. Preserve completed K1 owner-token and K2a scope identity parity. Runtime promotion/removal is S89, not this task. Implement the numbered checkpoints below, one coherent change at a time; no further decomposition exercise is requested.

## 1. Problem

The existing Rust primitives and CI vectors cover part of the identity surface. They must neither be rewritten nor mistaken for full runtime parity. Historical digests cannot change during deduplication.

## 2. Required change

Complete the six named identity checkpoints using the existing canonical/vector crates and actual TypeScript callers. New or different wire contracts keep their own semantics; equivalent algorithms share the existing primitive. Preserve one conformance system.

## 3. Documentation and checked files

[Launch09 K2b](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), [actual canonical exports](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/crates/eliotr-canonical/src/lib.rs), [actual vector exports](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/crates/eliotr-test-vectors/src/lib.rs), Language §§6/8.3/10.

```sh
git grep -n -F 'K2b — remaining M2 identity/serialization parity' -- docs/implementation/launch-prs/09-rust.md
git grep -n -e '^mod ' -e '^pub use' -- crates/eliotr-canonical/src/lib.rs crates/eliotr-test-vectors/src/lib.rs
```

## 4. Ordered checkpoints and oracles

| Checkpoint | Start and change | Required proof before advancing |
|---|---|---|
| 78.1 canonical body | Extend the current canonical JSON implementation and canonical_body vectors only for missing cases. | Specified numeric domain, UTF-16 key order, escapes, malformed Unicode, empty and size boundaries produce exact expected bytes/errors. |
| 78.2 stable IDs | Existing stable_id primitive/vector family; connect missing actual callers. | Changed domain/input/revision cannot produce an interchangeable ID; stored IDs stay identical. |
| 78.3 residency/cutover identity | Existing residency_key/owner-token primitives plus actual TS cutover serialization. | Owner/key/retention/domain differences remain bound; K1 tokens unchanged; malformed or foreign tuples fail. |
| 78.4 scope identity | Existing scope_snapshot_identity/K2a; add only missing S08/S99 request identity cases. | Full member set/input/profile differences remain visible; previous K2a vectors pass. Set algebra is S80, not a rewrite here. |
| 78.5 ingest/projection identity | Follow actual domain/contracts imports in current ingest and projection producers. | Same operation replay uses the same ID; changed source/parser/generation cannot replay old work; native/Wasm fixture bytes match. |
| 78.6 evidence/output identity | Exact current manifest/freeze/artifact/publication/federation codec callers exposed by their existing package exports. | Every active identity consumer has a named primitive/codec and retained independent fixture; incompatible formats remain separate, with unchanged historical digests. |

For each row: capture an independent accepted/invalid byte fixture from the current contract, run TS/native/Wasm, add the missing pure implementation or caller reuse, then rerun. Do not generate expected bytes by the implementation being tested. canonical-body.v1's safe-integer subset must not be imposed on other wire types. Preserve their own undefined/nonfinite/-0/error behavior where applicable.

Use `cargo test --locked -p eliotr-canonical`, the existing shared-vector tests, `pnpm rust:check-contracts` and `pnpm rust:wasm` during the checkpoint; finish with the applicable existing Rust deep gates. Record a specific unresolved mutation under #176 rather than inventing another mutation runner. A known TS defect requires an explicit corrected/versioned contract, not blind parity with the bug.

Keep the row's caller/function/fixture/implementing SHA/results in existing Launch09/ER40. New target domain crates for later families are not already present merely because the language contract names them. No network, clock, platform handles, source-body logs, serializer registry or all-family production switch.

## 5. Acceptance criteria

- [ ] Checkpoints 78.1–78.6 each have concrete actual callers and independent TS/native/Wasm byte/hash/ID/error results; completed rows are not rewritten unnecessarily.
- [ ] K1/K2a and old persisted fixture digests are unchanged; domain/order/escape/size negative mutations are detected.
- [ ] Equivalent recursion is genuinely reused; incompatible wire contracts are not merged under a common name.
- [ ] Existing Rust tests, applicable coverage/mutation and toolchain gates pass, with exact commands and per-checkpoint SHAs recorded.
- [ ] TS remains the production owner until that family's explicit S89 promotion. Closing this document or passing a CI self-test alone does not constitute runtime migration.
