# S78 — Complete remaining M2 canonical and identity parity

Baseline `a2aca127`; F26, ER-40/01/00. Existing canonical/test-vectors/kernel-wasm crates, K1 owner-token parity, and K2a scope identity parity must be reused. Runtime promotion is S89. This is a multi-checkpoint completion task, not one small all-family implementation commit.

## 1. Problem

CI-only Rust and committed vectors do not prove byte-identical coverage of every production-critical identity family. Refactoring must not change historical hashes or enshrine known TypeScript defects as a new contract.

## 2. Required change

Complete named K2b families in order: canonical-body, stable-id, cutover serialization, ObjectResidencyKey, ingest identities, projection identities, then the active evidence/manifest/publication/federation identity families identified by Launch09 and their actual callers. Work on one family per implementation checkpoint; do not rewrite completed K1/K2a or promote unrelated families together.

## 3. Documentation and exact search anchors

[Launch09](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md); [Language contract 8.3/10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'K2b — remaining M2 identity/serialization parity' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Implementation approach

Reconcile existing crates, fixtures, and real TS callers, including accepted S28/S77 changes. Run the same independently specified corpus through TS, native Rust, and compiled Wasm; do not derive golden bytes with the serializer under test. canonical-body.v1 uses its specified safe-integer subset and ECMAScript UTF-16 key ordering; other wire families retain their own numeric domains.

Cover UTF-8, escapes, lone surrogates, astral keys, null, -0 where admitted, boundaries, domain-separated IDs, and typed errors. Reuse the canonical parser and operation vocabulary. Track relevant mutation survivors through #176 and existing tooling, not a second mutation system. Correct an actual reference defect as an explicitly versioned decision before changing any immutable identity.

## 5. Acceptance criteria

- [ ] Every applicable family has an identified TS caller, Rust function, independent corpus, and native/Wasm byte/hash/ID/error parity result.
- [ ] K1/K2a and previously stored fixture digests remain unchanged; malformed, oversized, and foreign identities fail.
- [ ] Critical mutation/order/escape negatives are detected; `pnpm rust:check` and applicable existing deep gates pass.
- [ ] Rust remains effect-free and TS remains the production owner until the separate promotion checkpoint.
- [ ] Maintain family→caller→fixture→result in existing Launch09/ER40, with exact implementing SHAs. Do not close this task after only the first family or label it an already verified single-step instruction.
