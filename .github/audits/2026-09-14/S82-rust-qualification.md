# S82 — Port SourceAdmission and qualification; expose the offline verifier

Baseline `a2aca127`; ER-29/40. Targets: eliotr-qualification/contract-core and a thin native eliotr-bundle-cli adapter. Reuse accepted format/admission cases #239/#262 and S78 identity primitives; do not reimplement external parsing.

## 1. Problem

Parser success does not establish source admission, native coordinates, or assurance. The Rust port must retain typed limitations and candidate-only status until canonical settlement.

## 2. Required change

Port deterministic candidate/normalized-manifest validation, qualification and precision-lowering rules, and ownership/residency admission decisions. Provide a native offline bundle verifier over the same rules. Its successful result neither issues grants nor creates a SourceRevision.

## 3. Documentation and exact search anchors

[ER-29](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md); [Language ownership matrix](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'Absent mappings lower precision.' -- docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md
```

## 4. Implementation approach

Reuse strict source/library schemas, existing source-admission and qualification domain rules, and shared canonical primitives. Pure Rust receives verified byte identities and bounded metadata rather than reading D1, R2, or Google. Stream large native-file hashing through the CLI adapter; keep domain decisions effect-free.

Managed conversion, OCR, and PDF processing stay external through existing TS bindings. Unknown load-bearing fields, missing cutover receipts, and mismatched maps preserve their typed outcomes. A bounded CLI report and exit status must not log credentials or private document bodies. The native wrapper and pure rules are separate reviewable checkpoints, not an excuse to introduce another parser framework.

## 5. Acceptance criteria

- [ ] TS/native/Wasm agree on admission/quarantine/rejection for valid, corrupt, partial, absent-map, foreign-owner, wrong-residency, and unknown-field fixtures.
- [ ] Markdown availability does not imply native-page accuracy; candidates never become admitted automatically.
- [ ] Positive, negative, and repeated CLI invocation work on Windows/Linux without bundle mutation or remote calls.
- [ ] Existing Rust gates and actual ingress regressions remain valid; pure code has no I/O.
- [ ] Record exact functions, fixtures, SHA, and results. Runtime promotion is a separate S89 outcome.
