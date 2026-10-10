# S79 — Port owner lifecycle and cutover decisions to pure Rust

Baseline `a2aca127`; ER-02/40/13. Inputs: accepted TS domain behavior and S70/#262 cases, plus applicable S78/#270 identity primitives. Target: the language contract's eliotr-state-machines, not a new service. Runtime promotion and TS removal are separate S89 work.

## 1. Problem

Owner-token byte parity does not verify whether an ownership transition is allowed. Lifecycle, incarnation, fence, and bilateral cutover decisions need parity while SQL retains transactional compare-and-swap enforcement.

## 2. Required change

Port only the pure decision: observed owner/incarnation/fence, proposed command, and verified bilateral receipt facts produce a typed transition or denial. Source acquisition, D1 mutations, and R2 transfer stay in TS adapters.

## 3. Documentation and exact search anchors

[Launch09 K3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md); [Language contract section 10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'K3.owner lifecycle/cutover' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Implementation approach

Extract actual accepted domain functions and enumerate existing schema states/commands rather than inventing new enums. Pass observed facts and time explicitly; pure Rust performs no network, database, or clock access. Reuse canonical fixtures and the shared versioned Wasm envelope, not another parser or receipt format.

Compare TS/native/Wasm transitions, IDs, and exact denial codes. A successful pure decision is not a commit receipt: SQL must still verify unchanged current rows and CAS at settlement. Additional input fields require versioned fixtures. Correct any established TS defect before claiming semantic parity.

## 5. Acceptance criteria

- [ ] Valid initialization, bilateral transfer, and retirement have identical transitions/IDs/errors across TS/native/Wasm.
- [ ] Unilateral receipts, stale fences/incarnations, changed source-set/view, conflicting command replay, and resurrection fail.
- [ ] Property/mutation tests detect dual ownership and missing fences; existing D1 race tests remain valid.
- [ ] Applicable fmt/clippy/nextest/deny/coverage checks pass without I/O or unsafe code in the pure crate.
- [ ] Record exact callers, fixtures, implementing SHA, and results; do not claim runtime promotion before S89.
