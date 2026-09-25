# S86 — Port erasure closure and terminal admissibility to Rust

Baseline `a2aca127`; ER-28/40. Target eliotr-erasure-core. Reuse accepted #255 deletion semantics and #270/#273 identity/policy primitives; external deletion adapters remain TypeScript.

## 1. Problem

PURGED requires a complete verified closure. Migration must not replace evidence of absence with a count of successful deletion requests.

## 2. Required change

Port pure closure normalization, identity matching, hold/retention conflicts, and terminal-completion decisions. Inputs contain expected managed locations, exact verified absence/blocked observations, and current purge/ownership facts. Outputs use the existing typed complete/blocked/pending contract.

## 3. Documentation and exact search anchors

[Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md).
```sh
git grep -n -F 'K4.erasure exact closure' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Implementation approach

Reuse current erasure schemas and coordinator decisions as effect-free functions. Scope/domain/object/version must match exactly. Deduplicate identical observations; a duplicate never replaces a missing location. TS adapters supply verified observations, not untrusted client assertions. Evaluate holds, review dates, and expiry against explicitly injected time.

Keep purge-ledger append, absence reads, and physical deletion in TS/D1/platform adapters. Rust performs no deletion and creates no queue. Do not alter historical tombstones or receipts to manufacture parity. A newly discovered dependency requires re-evaluation of completion evidence; previously observed absence cannot prove closure over an expanded dependency set.

## 5. Acceptance criteria

- [ ] TS/native/Wasm agree on full, partial, missing, duplicate, wrong-domain, wrong-version, and retention-lock cases.
- [ ] Late dependencies cannot produce false completion, resurrection, or deletion of unrelated data.
- [ ] Mutation of a required closure check is detected; #255 purge/restart/hold regressions remain valid.
- [ ] Pure code has no I/O or hidden clock and applicable Rust gates pass.
- [ ] Record fixtures, exact SHAs, and results. Actual caller promotion is separately verified under S89.
