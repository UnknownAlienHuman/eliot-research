# S22 — Perform actual counter-search within the selected corpus

Baseline: `a2aca127`; finding F06. A bounded part of #92, not implementation of every Research product at once. Consume the agreed frozen protocol contract from S35 when integrating the complete pipeline.

## 1. Problem

COUNTER_SEARCH can currently finish as a technical checkpoint without searching for counterevidence. A protocol that requires counterevidence remains unimplemented regardless of an 18/18 checkpoint count.

## 2. Required change

Implement one corpus-only counter-search branch through existing retrieval and the evidence ledger before FREEZE_EVIDENCE. Do not add a web crawler, swarm framework, or second Workflow.

## 3. Documentation and exact search anchors

[Architecture, sections 7.2, 7.8, and 7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'counter_search_required:' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.8. Research branches' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Connect a handler through the existing stage factory. Read the frozen protocol and proposition under examination, search the authorized corpus, and resolve candidates into exact EvidenceHandles. Use current cancellation and budget mechanisms. Persist counterevidence and unsuccessful checks in the existing model; reconciliation/freeze must make this material available to synthesis and audit. Do not force counter-search onto simple lookup protocols that do not require it. Successful counter-search alone does not establish E2/E3.

## 5. Acceptance criteria

- [ ] A fixture containing a contradictory source produces counterevidence in the freeze and final audit/report.
- [ ] Counterevidence outside leading sections is actually retrieved, not preinserted into the result.
- [ ] No-hit in a sampled scope is not proof that counterevidence is absent.
- [ ] Foreign/purged hits, budget exhaustion, and cancellation are handled; replay does not repeat a persisted stage.
- [ ] Exercise the real D1/R2 stage chain and record exact SHA/results. Other unfinished stages are not declared implemented.
