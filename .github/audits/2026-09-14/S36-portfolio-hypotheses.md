# S36 — Persist questions, hypotheses, and the evidence portfolio

Baseline: `a2aca127`; ER-08/10. Depends on #227. One linked W1 planning-state operation, not a graph database.

## 1. Problem

Without QuestionGraph, HypothesisCard, and SourcePortfolio, Research does not explicitly preserve subquestions, alternatives, or source independence. Retrieved chunk count is not a substitute for that structure.

## 2. Required change

From the approved protocol/obligations, persist a versioned question graph, required hypothesis cards, and SourcePortfolio with required/missing source classes and lineage/family information. Graph edges represent questions/dependencies, not arbitrary model-generated causal claims. Lookup may legitimately have an empty hypothesis set without a planning LLM call.

## 3. Documentation and exact search anchors

[Architecture, sections 7.5–7.6 and Slice 4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 7.5. SourcePortfolio and coverage denominator' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.6. HypothesisCard' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Extend existing Investigation ledger commands/schema and reuse reference/residency primitives and W1 revision CAS. Build the portfolio from admitted source references only; list uncaptured candidates separately as missing evidence/acquisition work. Source-family identity cannot be inferred solely from URL/domain or provider count: retain lineage, same-origin duplication, and unknown independence explicitly.

Update hypothesis status from evidence and named-verifier outcomes, not an arbitrary model score. Question graph, cards, and portfolio share a linked W1 revision/readback. Restart reads that persisted input instead of reconstructing it from a lead-agent summary. Branch handlers consume the same stored planning state.

## 5. Acceptance criteria

- [ ] Two questions sharing a premise retain a linked graph and their rival hypotheses.
- [ ] Ten copies of one source do not become ten independent confirmations; missing required classes remain explicit debts.
- [ ] Foreign/unadmitted references, invalid dependency cycles, stale CAS, and retry cannot produce inconsistent revisions.
- [ ] Verify actual ledger/API readback and branch-factory integration; record exact SHA/results.
- [ ] No external graph service or parallel planning-state store is introduced.
