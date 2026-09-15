# S75 — Read, review, edit, and publish Wiki/reports clearly

Baseline: `a2aca127`; ER-25/11/12. Use compiler/publication/dependencies #245–#247 and historical reading #199. Do not rewrite Research layout #218.

## 1. Problem

Mixed Published/Proposed/DRAFT labels and repeated technical explanations make document status unclear. Users must be able to tell whether content is published and which claims were actually verified.

## 2. Required change

Separate draft listings, published versions, and selected-revision viewing in the existing Wiki/report UI. Provide text, claim verdicts/citations, history, section edits, authorized review/publication, and export. Show source freshness, editorial publication, and evidence acceptance as distinct properties.

## 3. Documentation and exact search anchors

[Architecture 9.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [production plan 8.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).

```sh
git grep -n -F '### 8.5 Wiki and artifact materialization' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Reuse Wiki/artifact APIs and panels. Selecting a revision does not mutate the canonical head. Editing creates a COW revision; changed statements do not inherit the previous audit. Explain unavailable publication rather than leaving an unexplained disabled button, and bind confirmation to the exact revision.

On stale CAS, offer comparison/reload instead of automatic overwrite. Export verifies every part and preserves DRAFT/limitations/verdicts. Read long reports by requested sections rather than a single whole-report/corpus JSON payload. Reuse existing styling, accessibility, and mobile conventions; no new workflow/renderer library.

## 5. Acceptance criteria

- [ ] Draft→exact citation→edit B→review→publish→reopen v1/v2 succeeds; valid unchanged A/C dependencies retain their hashes.
- [ ] Edited unsupported claims cannot look verified; lack of permission, purge, stale source, and CAS conflict cannot be bypassed by UI actions.
- [ ] History/export after reconnect refer to the same artifact and claims; incomplete export is not called complete.
- [ ] Actual browser/HTTP/storage tests and accessible desktop/mobile/dark/light screenshots are recorded.
- [ ] Include exact SHA/results and preserve one existing renderer/API implementation.
