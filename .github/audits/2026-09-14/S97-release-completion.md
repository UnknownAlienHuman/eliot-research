# S97 — Complete mandatory v1 acceptance and the production canary

Baseline `a2aca127`; release owner, ER-26/27/00. This is final acceptance, not a new gate system or a task that implements missing features by itself. Inputs include mandatory Slices 0–6 of the selected gemini-mcp profile, production-critical Rust M1–M7, and actual local/quality/deployment/native/workload results #284–#288. S98/S99 remain mandatory headless/corpus inputs despite later numbering.

## 1. Problem

Closed PRs, green CI, and an available Worker do not prove production readiness. The selected product must work on compatible actual generations, including source intake, research, outputs, external clients, and recovery.

## 2. Required change

Reconcile existing implementation-status.json, gap-register, release-checklist, and security-checklist with actual execution evidence. Close required gaps only through identified fixes and applicable acceptance. Then run the documented canary scenarios and create the existing-format release receipt.

## 3. Documentation and exact search anchors

[Production readiness Phase 14](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F '## 16. Phase 14 — production launch' -- docs/implementation/production-readiness-plan.md
git grep -n -F 'Only after this receipt is complete' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

For each mandatory requirement, identify the real caller, negative/replay test, configured runtime, and applicable actual qualification. Existing partial live cases remain partial evidence: do not erase them or inflate them into complete qualification. Record Worker/schema/R2-residency/search/AI Search/Rust ABI+Wasm/PWA/Access/Google/model-route identities and rollback targets.

Canaries cover new source→exact retrieval/open→governed run→accepted artifact/Wiki publication→federation job→selected Workspace action→disposable erasure→clean restore. The release owner approves the observation window and production head; the agent cannot appoint itself approver.

Known mandatory defects, overdue erasure, and unhandled DLQ conditions block release under the existing rules. Newly demonstrated defects return to the owning task with regression evidence, not an unlimited expansion into optional products. Keep README/START-HERE/indexes/status consistent with the actual release. Superseded planning branches must not be wholesale-merged or unmerged user work automatically deleted.

## 5. Acceptance criteria

- [ ] Every mandatory selected-profile requirement has an implemented caller, applicable negative/replay evidence, and actual required qualification, without missing or stale receipts.
- [ ] T0–T6, safety/erasure/restore/rollback, and production-critical Rust pass their own criteria; affected generations are requalified when changed.
- [ ] Canaries, current Access/secrets/budgets, and applicable DLQ/erasure release conditions pass; the release owner explicitly approves production after observation.
- [ ] Publish one exact release receipt naming required identities and results. Only then use production-ready terminology.
- [ ] This proves acceptance for the stated version/profile/tested envelope, not absolute freedom from every future defect. A completed planning checklist or finite test suite is not such a guarantee.
