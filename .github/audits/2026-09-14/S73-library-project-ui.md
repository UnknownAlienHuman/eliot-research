# S73 — Complete a simple Library/project user flow

Baseline: `a2aca127`; ER-25/30. S03/#195 repairs one browser regression. This task completes the Sources experience through existing project/catalog/admission/revision APIs, not another backend.

## 1. Problem

Sources has overlapping workspace/project/import panels, competing refresh controls, and poorly labeled actions. A partially stored upload can look ready, leaving users unsure what to do next.

## 2. Required change

Provide one project selector, one source list, and one Add document flow with distinct upload/processing/admission/index-readiness states. Support project creation/rename, attaching/detaching existing sources, revision opening/replacement, and navigation to Lens/Research. Multiple-file selection uses bounded per-file operations, not an unlimited batch or false all-success result.

## 3. Documentation and exact search anchors

[Production plan 8.7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md); [ER-25](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-25-owner-pwa.md).

```sh
git grep -n -F '### 8.7 Owner PWA' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Reorganize existing main.ts, project/library/raw-file panels, and API clients. No React rewrite or state-management framework. Every action has an accessible label and exact project/source/revision identity. Membership mutations retain expected-revision/CAS; sharing a source with a second project does not upload it again. Index readiness is distinct from admission.

Preserve idempotency after lost responses and reselection. One file's failure must not discard other successful imports. Empty/error/blocked states explain the next action; technical IDs stay in details. Test keyboard/focus, mobile, and dark/light behavior on actual controls, not screenshots alone.

## 5. Acceptance criteria

- [ ] Empty account→workspace→two projects→import→attach shared source→revision update→Lens→Research works without manual SQL or canonical-source duplication.
- [ ] Stale membership, conversion failure, reload/lost ACK, forbidden source, and purge states are truthful; buttons have nonempty labels.
- [ ] Main actions remain visible on desktop/mobile without competing import/refresh forms; focus and keyboard navigation work.
- [ ] Existing API/storage identities are preserved in short real-browser scenarios using the shared harness.
- [ ] Attach dark/light/mobile screenshots, exact SHA, and test results.
