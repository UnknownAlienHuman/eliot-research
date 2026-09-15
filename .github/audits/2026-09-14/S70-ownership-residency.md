# S70 — Preserve source ownership, residency, and explicit snapshot imports

Baseline: `a2aca127`; ER-02/03/14/29/30. Prioritize integrating and testing existing mechanisms, not building another ownership service.

## 1. Problem

A document shared by two projects does not have two mutable owners. Equal bytes do not authorize deduplication across encryption-key, retention, or disclosure domains. Unsaved editor content must not be captured implicitly.

## 2. Required change

Complete and test three admission boundaries through the existing normalized-bundle/ingest API: exact originating owner/view, full ObjectResidencyKey, and a separate bilateral source.owner-cutover.v1 receipt when ownership actually transfers.

## 3. Documentation and exact search anchors

[Architecture 29.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [ER-29](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md).

```sh
git grep -n -F 'Submit unsaved editor bytes without explicit snapshot origin/view/policy receipt' -- docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md
git grep -n -F 'source.owner-cutover.v1' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse ownership/cutover domain logic, admission service, and existing bundle schema. Ordinary external imports preserve external-owner lineage. Becoming mutable owner requires actual prior/new-owner authorizations bound to exact source set/view, not a boolean flag. After cutover, old writer/fence credentials cannot mutate the source.

Check complete residency before reusing objects/keys; membership alone does not authorize disclosure. Explicit unsaved snapshots create a separate authorized revision/view, without automatically monitoring editor buffers. Partial-cutover recovery continues the original identity and must not admit two ACTIVE owners.

## 5. Acceptance criteria

- [ ] Two projects sharing a source retain one canonical identity and correctly separated permissions.
- [ ] Unilateral/foreign cutover, stale owner, mismatched revision set, cross-residency equal-byte reuse, and unsaved content without authorization fail before writes.
- [ ] Bilateral authorized cutover converges after lost ACK/restart; old writers fail and historical revisions/receipts remain.
- [ ] Actual ingest/D1/R2 tests use current contract fixtures; a missing external-peer receipt is not replaced with an assertion.
- [ ] Record exact SHA/results and supported precision/disclosure boundaries.
