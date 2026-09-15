# S46 — Complete DEEP_RESEARCH by composing existing stages

Baseline: `a2aca127`; ER-08/09/10/11. Uses #227–#232 and #214. Scope: product composition over those implementations, not another lead agent.

## 1. Problem

Eighteen completed checkpoints or a FRONTIER-class model do not establish E2/E3 research. DEEP requires an explicit procedure, alternatives, controlled acquisition, evidence freeze, audit, debts, and coverage.

## 2. Required change

Connect an approved DEEP_RESEARCH profile to the existing Workflow's protocol/portfolio/branches/acquisition/counter/reconciliation/freeze/synthesis/audit/materialization path. Distinguish selected model capability, execution product, and required Evidence Grade in request/status/report. Do not create another lead-agent loop.

## 3. Documentation and exact search anchors

[Architecture, sections 7.12 and 8](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'An E2/E3 Investigation with explicit protocol' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Profile compilation #227 determines mandatory branches/verifiers. Each uses existing bounded context, W3, and source policies. corpus_only and corpus_plus_web authorize different routes. Additional work after freeze becomes an explicit debt/reopen, not an invisible self-improvement loop. Registered stop/deadline/cancel rules prevent further spend without discarding useful partial output. Handoff/restart reads W1/R2 state rather than an agent's summary.

Missing source independence or a verifier is not repaired by silently lowering the requested grade or labeling the result validated. Preserve the existing real synthesis and claim audit. Integrate dependencies rather than implementing their functions again in the DEEP profile.

## 5. Acceptance criteria

- [ ] A fixture with two independent source families and counterevidence meets its specified E2 obligations; E3-confirmatory requires #230's registration/verifier path.
- [ ] Single-origin or insufficient-coverage fixtures return their appropriate constrained/partial/inconclusive result and next probe, not fabricated E2/E3.
- [ ] Long-run recovery retains state, provider changes are explicit/versioned, and existing spend policy remains enforced.
- [ ] One actual Workflow produces all required outputs and readable exact citations.
- [ ] Record local integration tests/SHA separately from subsequent real-model quality measurements.
