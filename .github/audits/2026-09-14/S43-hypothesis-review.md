# S43 — Preserve testable alternatives in HYPOTHESIS_REVIEW

Baseline: `a2aca127`; ER-08/10/11. Inputs: #228/#229/#230/#232.

## 1. Problem

A list of hypotheses without predictions, falsifiers, alternatives, and scoped outcomes is not a completed HYPOTHESIS_REVIEW product.

## 2. Required change

Use an installed product profile to read persisted HypothesisCards, bind discriminating checks to existing obligations/branches, and preserve support, counterevidence, alternatives, and a scoped status for each hypothesis. Produce a section-versioned artifact with next probes, not another knowledge graph.

## 3. Documentation and exact search anchors

[Architecture, sections 7.6 and 7.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 7.6. HypothesisCard' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse card identities/W1 revisions and model/audit/artifact adapters. Each discriminating check references a concrete measurement/source/proof obligation and its verifier. Model reasoning alone cannot authoritatively assign supported/falsified status. Preserve origin and exposure lane; exploratory tuning on the same data does not confirm a preregistered hypothesis. Evidence involving different populations, times, or assumptions is not automatically contradictory.

Retain unknowns and failed probes. Budget exhaustion cannot remove an unsuccessful alternative from history. New results update cards through #232's revision/reopen mechanism; old artifacts remain immutable.

## 5. Acceptance criteria

- [ ] Two rival hypotheses and an unresolved confound retain both alternatives, predictions/falsifiers, and a concrete next probe.
- [ ] Refutation is linked to an exact source span or measurement, not a confidence score.
- [ ] Scoped unknown does not become universally false; discarded alternatives remain recorded.
- [ ] Replay/cancel/reauthorization and source-revision changes preserve correct authority/history.
- [ ] Actual branch→audit→artifact tests, not schema tests alone, pass; record exact SHA/results.
