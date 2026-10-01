# S93 — Qualify retrieval and Research quality on an adjudicated T2/T3 corpus

Baseline `a2aca127`; ER-23/27. Reuse existing Golden fixtures GC-009–012 and assertions. This is quality acceptance after applicable code is complete; preparing the corpus can happen earlier. It is not a small implementation fix or a promise that all future answers will be correct.

## 1. Problem

One successful run over two documents does not establish large-corpus retrieval, sound synthesis, contradiction handling, or completeness.

## 2. Required change

Extend the existing adjudicated corpus/runner across LOCATE, ASK, BRIEF, COMPARE, HYPOTHESIS_REVIEW, FACT_CHECK, PROJECT_VS_LITERATURE_AUDIT, DEEP, and REPORT. Measure appropriate per-product metrics and apply the corresponding canonical thresholds rather than one undifferentiated accuracy score.

## 3. Documentation and exact search anchors

[Production plan Phase 9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md); architecture sections 19.2–19.5/19.8.
```sh
git grep -n -F '## 11. Phase 9 — build and adjudicate the real T2/T3 corpus' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Before evaluating a candidate, label independent source spans, constraints/denominators, acceptable claims/limitations, and forbidden semantic collapses. Include Russian/English, code/tables/units, long/mixed/conversation documents, conflicting versions, relevant tail sections, absent native maps, no-answer cases, injection, shared source families, and scopes exceeding a first page.

Do not derive ground truth from the evaluated model's own answer. Use authorized de-identified or synthetic documents with provenance; real documents require permission. Separate tuning and holdout. Record corpus hashes, model/prompt/parser/index generations, sample counts, failures, and stochastic repeat conditions. Recall@20 initially >=0.90 is not a claim of perfect answer accuracy. Exact accepted-citation validity and forbidden-collapse checks are separate requirements. Controlled-provider fixtures are not actual model/index quality measurements.

## 5. Acceptance criteria

- [ ] Per-product reports retain sample sizes/denominators, recall, exact citation validity, support/counterevidence handling, false positives/negatives, abstention/coverage, and measured latency/cost where available.
- [ ] Evaluated cases contain no accepted unsupported claims or forbidden collapses; sampled no-hit does not become complete absence. Failing cases remain visible and block the affected qualification.
- [ ] Golden comparisons cover previous/candidate generations; a regressing candidate is not promoted and the retained generation remains usable.
- [ ] Actual provider/index evaluations run only against an approved deployment/budget. Missing executions are NOT_EXECUTED, never inferred PASS.
- [ ] Retain exact SHA/config/corpus, commands, and results; do not generalize a finite accepted corpus into a universal guarantee.
