# S55 — Propagate source changes and erasure to derived content

Baseline: `a2aca127`; ER-11/12/13/28. Existing change producers in migrations 0060–0066 and historical readers already exist. #212's UI refresh and #199's historical reads do not replace the complete dependency lifecycle.

## 1. Problem

Source-head updates, revocation, and erasure have different consequences. Neither clearing everything after every update nor continuing to use purged evidence in derived objects is correct.

## 2. Required change

Complete ArtifactDependencyManifest/section/Wiki/evidence-map links to source, handle, derived artifact, and governed export references. Add missing atomic change producers, authorized replay, and targeted stale/redacted behavior. After #246, connect WIKI/ARTIFACT retrieval lanes to verified readers rather than arbitrary draft text.

## 3. Documentation and exact search anchors

[Architecture, sections 9.2–9.6, 19.6, and 19.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'ArtifactDependencyManifest' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 19.9. Erasure' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Capture dependencies with canonical mutations rather than later best effort; preserve atomic head/outbox settlement. Updates mark dependent sections stale while retaining authorized historical revisions. Purge/revocation requires redaction/denial and erasure-inventory propagation. New read grants cannot resurrect purged content.

Bind feed cursors to principal/project/snapshot/revision. Deduplicate replay and require explicit resync for expired cursors, not a false empty success. WIKI/ARTIFACT lanes check acceptance/review state, labels, and original lineage. Self-citation does not make a derived report an independent primary source. Governed external copies use existing export contracts; do not promise deletion of uncontrolled user downloads.

## 5. Acceptance criteria

- [ ] Source→Wiki→report→export dependencies become appropriately stale on update and denied/redacted on purge, including dependencies recorded only in omissions.
- [ ] Unrelated projects are unaffected.
- [ ] Lost notifications/restart recover through feed and D1/R2 state; unauthorized cursors disclose no metadata.
- [ ] Cyclic self-citation cannot inflate evidence independence.
- [ ] Test actual producers, consumers, readers, and search; record exact hashes/SHA and erasure-inventory linkage.
