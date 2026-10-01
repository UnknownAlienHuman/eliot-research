# S20 — Refresh only views affected by a source revision

Baseline: `a2aca127`; finding F18.

## 1. Problem

`refreshAfterSourceAdmission` calls `researchRun.invalidateSourceRevision()` after every raw admission. That method clears the open report and forgets its Workflow ID without checking dependencies. Importing an unrelated document therefore closes the user's current work.

## 2. Required change

Include confirmed source/revision IDs in the existing event and refresh only affected reports/Wiki views. When a relevant head changes, display previous-revision status and recheck read authorization rather than destroying the historical report.

## 3. Documentation and exact search anchors

[Architecture, sections 9.2 and 9.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 9.2. Copy-on-write section tree' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'refreshAfterSourceAdmission' -- apps/eliotr-pwa/src/main.ts
git grep -n -F 'invalidateSourceRevision' -- apps/eliotr-pwa/src
```

## 4. Implementation approach

Take source identity from the actual admission response and use the opened report's existing dependencies/freshness data. Do not infer identity from filenames or add a global event bus. If dependency metadata is unavailable, request a freshness check without automatically rerunning a model. Genuine revocation/purge must still hide protected content. Preserve the original report ID and hashes.

## 5. Acceptance criteria

- [ ] Unrelated source admission leaves the open report, draft, and selection intact.
- [ ] Updating a dependent source shows previous-revision status while preserving the original report.
- [ ] Duplicate events do not cause duplicate refresh work or model calls.
- [ ] Cached views and late responses cannot bypass revocation/purge.
- [ ] Browser tests cover two independent projects and a relevant source update; record exact SHA/results.
