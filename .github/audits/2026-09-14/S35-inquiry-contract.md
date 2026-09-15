# S35 — Persist the inquiry protocol and actual obligations

Baseline: `a2aca127`; ER-08/09/10/21. Reuse research-session.ts, protocol-freeze, and the existing Investigation ledger/contracts. Do not replace W1 authority. Compatibility correction: current legacy parsing explicitly accepts grades E0–E2; an old request must not be silently coerced to E0.

## 1. Problem

PLAN/COMPILE_OBLIGATIONS labels and technical checkpoint bytes do not define a research procedure. The inquiry needs a versioned protocol bound to its question, requested rigor, and output product.

## 2. Required change

Add an explicit run-request version carrying a reference to an installed InquiryProtocolProfile (`inquiry_protocol_ref`), not arbitrary client-supplied policy JSON. Preserve the existing unversioned request's accepted fields, requested grade, budget, and behavior. Do not reinterpret an accepted E1/E2 legacy request as an E0 default. A new request contract must be explicitly distinguishable from the existing strict schema and reject unknown load-bearing fields.

Persist query/intended artifact, selected profile revision, grade, lane, source_mode, coverage goal, budget/stop rule, and InquiryObligations with dependencies, verifier, and certificate kind through existing W1. Model suggestions are candidates; authoritative policy/verifier fields come from the installed profile.

## 3. Documentation and exact search anchors

[Architecture, sections 7.2–7.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [current request parser](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/research-session.ts).

```sh
git grep -n -F '## 7.2. InquiryProtocolProfile' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.4. Inquiry obligations and acceptance certificates' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'parseResearchRunRequest' -- apps/eliotr-core/src/research-session.ts
```

## 4. Implementation approach

Decode legacy and new strict contracts in the existing run API. New request identity includes the profile reference/revision; the same key cannot replay a changed protocol. Freeze authorized inputs, then persist the plan using existing W1 commands/CAS, not a separate task-graph service. Interpretation and obligation compilation may be merged into a cheap deterministic stage, but their output must contain the real obligations.

Missing approved protocol/verifier produces a typed blocked obligation/next probe, not success. Scope or grade cannot change silently during execution. Store selected profiles in existing configuration/contracts, not another registry. corpus_only performs no acquisition network calls. Any genuinely needed expensive planning call uses W3 once; simple lookup requires no planning LLM by default. Product-specific tasks consume this common contract.

## 5. Acceptance criteria

- [ ] Lookup, evidence review, and architecture-decision fixtures produce their specified distinct obligations and immutable profile binding.
- [ ] Replay/restart retain the plan; changed profile/query under the same key conflicts.
- [ ] Legacy valid E0/E1/E2 requests preserve their requested grade and existing acceptance/rejection behavior. No implicit downgrade or expanded legacy field acceptance occurs.
- [ ] Foreign verifier, unknown fields, invalid grade/source route, and missing authority fail; a checkpoint alone cannot issue an ACCEPTED certificate.
- [ ] Record actual W1/D1/HTTP tests, exact SHA, and owner-loop regression results. Do not introduce parallel planners for individual products.
