# S30 — Reconcile current product status without another registry

Baseline: `a2aca127`; finding F22. Scope: owner import → retrieval → Research DRAFT and their entry documents, not a rewrite of all documentation.

## 1. Problem

START-HERE interprets LIVE_QUALIFIED=0 as the absence of any real platform checks, although retained live records describe successful individual operations. These are different levels of evidence. An append-only log containing several historical statements of what is current is not an authoritative current deployment record.

## 2. Required change

Distinguish implemented code, an individual retained live case, observed deployed version, and complete subsystem qualification. Reuse implementation-status.json and evidence links; do not create status-v2 or another master report.

## 3. Documentation and exact search anchors

[START-HERE, section 7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/START-HERE.md); [production-readiness plan, section 0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).

```sh
git grep -n -F '## 7. The four states, and what' -- docs/START-HERE.md
git grep -n -F '### Mechanical release rule' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Check the named owner-path entries against actual callers/tests and retained receipts. Remove the invalid implication that zero fully qualified subsystems means no successful real round trip. Keep historical audits/live records historical. Identify a current deployment only with an observation time and source, not by assuming it equals the latest main SHA. Do not promote a status merely because a file exists or one example passed. Leave an explicit gap for checks not executed.

## 5. Acceptance criteria

- [ ] Entry documents, registry, and capabilities make compatible claims about the owner path.
- [ ] An individual live case is not described as full qualification, and incomplete qualification does not deny that the case happened.
- [ ] Main-only fixes are clearly distinguished from deployed/live-accepted fixes.
- [ ] Documentation-index checking passes for the affected documents.
- [ ] No new CompletionDisposition, status registry, or repeatedly copied prose counters are introduced. Retain exact SHA and evidence links.
