# S49 — Build ProjectAtlas from the selected project, not arbitrary top-k results

Baseline: `a2aca127`; ER-30/31/39. Reuse SourceCard, DocumentMap, and materialization; structural reading is #240.

## 1. Problem

Metadata orientation and individual SourceCards do not complete a project map or explain source coverage. The gap register leaves the full Atlas path open.

## 2. Required change

Build an immutable ProjectAtlas from authorized source cards/maps: frozen membership, thematic reading routes, represented/omitted references with reasons, and exact references for structural expansion. Start within the current supported scope; full logical-scope integration is S99, not a blanket increase of constants.

## 3. Documentation and exact search anchors

[Architecture, sections 6.5–6.7 and 19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'ProjectAtlas' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 19.5. Projects and disclosure' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Use existing navigation stores, source references, and scope service. Assemble deterministically from exact authorized membership; no graph database. One source belonging to two projects does not create a second canonical SourceRevision. Missing parser/map/source classes remain explicit omissions rather than disappearing from the denominator. Topic labels/routes are navigation only; factual support requires exact Evidence resolution.

Membership/source-head changes create new Atlas revisions. Do not mix stale cached maps with current scopes. UI ORIENT opens a specific route→section→evidence. Metadata visibility alone is not a grant to all source bytes.

## 5. Acceptance criteria

- [ ] Two projects sharing a source have correctly scoped Atlases and one canonical source revision without cross-project disclosure.
- [ ] The eligible set is reconciled with represented members and explicit omissions; unknown denominator does not become complete.
- [ ] Changes/purge affecting a source listed only in omissions still invalidate dependent views.
- [ ] Replay/restart preserve immutable Atlas hashes.
- [ ] Actual orientation/expand/API/browser tests pass; record exact SHA/results and integrate S99 before claiming large-project acceptance.
