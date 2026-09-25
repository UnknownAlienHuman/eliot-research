# S85 — Port Research freeze, acceptance, reopen, and publication decisions

Baseline `a2aca127`; ER-08/10/11/12/40. Target eliotr-research-core with existing state/coverage primitives. Accepted protocol/obligation work #227/#230/#232 and publication #246 provide the reference, not obsolete technical placeholders. Implement these related decisions as separately reviewed checkpoints.

## 1. Problem

Rust must implement substantive decisions, not cement the false implication that eighteen completed steps prove a completed investigation. A model cannot appoint itself as the acceptance verifier or publication authority.

## 2. Required change

Port pure W1 transitions, freeze-lineage/claim-audit acceptance, terminal disposition/reopen, and D0–D3 publication admission. Model calls, Workflow effects, D1 CAS, and R2 publication remain TypeScript responsibilities.

## 3. Documentation and exact search anchors

[Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md); [Architecture 7.4/7.11/9.6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'K4.research freeze/audit/completion' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Implementation approach

Inputs include current W1 revision, registered protocol/lanes, obligations, named-verifier certificates, exact evidence/freeze references, debts, requested transition, and observed policy facts. Caller prose or confidence is not authority.

Preserve the existing nine dispositions, reasons/next probes, and exploratory/confirmatory separation. A post-exposure rule change requires declared deviation/reopen rather than silent modification. Edited publication content does not inherit verification for the old statement. Pure output proposes an event or typed denial; SQL still checks unchanged authority atomically at commit. Do not introduce another Workflow engine, review system, or language-specific public API.

## 5. Acceptance criteria

- [ ] TS/native/Wasm agree on legal W1 transitions, all nine terminal outcomes, verifier/waiver/grade rules, and D0–D3 decisions.
- [ ] Technical completion or self-approval cannot bypass obligations; unapproved post-freeze/post-exposure changes, missing material support, and stale publication fail.
- [ ] Cancellation/reopen preserves previous receipts and accepted currentness/history behavior.
- [ ] Mutation/state-machine properties detect missing checks; retain applicable Rust gates, fixtures, exact SHAs, and results.
- [ ] Production remains TS-owned until S89; actual product-chain promotion tests are required before claiming runtime completion.
