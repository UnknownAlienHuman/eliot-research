# S21 — Distinguish research work from technical checkpoints

Baseline: `a2aca127`; finding F06. This task makes the actual pipeline transparent; it does not require 18 agents.

## 1. Problem

Eight stages use deterministicWorkflowStageBytes, returning hash/operation/stage/attempt data. A receipt named COUNTER_SEARCH or PLAN does not prove that the corresponding procedure ran. Some orientation/retrieval work already occurs elsewhere; do not describe the entire product as empty.

## 2. Required change

Tie stage presentation and trace records to actual handlers and artifacts. Distinguish a technical checkpoint, work merged into another stage, and an unmet protocol obligation.

## 3. Documentation and exact search anchors

[Architecture, sections 7.4 and 7.7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'An implementation may merge adjacent inexpensive stages.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'A summary, score, model agreement, or completed Workflow step' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'deterministicWorkflowStageBytes' -- apps/eliotr-core/src packages/cloudflare-workflows/src
```

## 4. Implementation approach

Identify actual executors and supporting output references in the existing stage factory/trace/status path. Preserve the 18 checkpoint IDs and historical receipts instead of changing them for presentation. Derive descriptions from existing assembly rather than creating another registry. Name unimplemented required obligations explicitly; do not strengthen grade/disposition merely because a checkpoint completed. S22 separately implements actual counter-search.

## 5. Acceptance criteria

- [ ] Technical PLAN/COUNTER_SEARCH checkpoints are not presented as completed research procedures without corresponding outputs.
- [ ] Real work merged into another stage remains visible with its trace and output references.
- [ ] ENGINE_COMPLETED does not automatically imply research completeness.
- [ ] Replacing a meaningful handler with technical bytes is detected by a regression test.
- [ ] Record exact SHA, tests, and the corresponding existing gap/status update; introduce no new framework.
