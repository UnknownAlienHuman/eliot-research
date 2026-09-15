# S33 — Let a long run outlive a short session, not revoked authority

Baseline: `a2aca127`; ER-09/13/24/30. Complements #197/#198 rather than reimplementing historical reading.

## 1. Problem

ScopeService defaults to a 15-minute snapshot, and the W2 current view requires unexpired snapshots/grants. Renewing a model proof does not renew these permissions. Reading history after JWT rotation and continuing an active operation are different requirements.

## 2. Required change

At launch, bind server-execution authorization to the operation with a deadline bounded by already authorized policy/delegation/budget, independently of the browser bearer's lifetime. Preserve the short-lived snapshot as immutable provenance. Rechecking permission for the same frozen members must not refreeze current source heads. Actual upstream expiry or explicit revocation stops dispatch and preserves the run with its appropriate blocked/constrained state.

## 3. Documentation and exact search anchors

[Architecture, sections 7 and 7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [Workflow checkpoints](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/workflow-checkpoints.md).

```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'loadHeldResearchScope' -- apps/eliotr-core/src packages/cloudflare-research/src
```

## 4. Implementation approach

Reuse scope_access_grant, W1 authorization receipts, and the held-scope loader; do not create a session/token service. Separate read-bearer checks from server-execution grant checks. Workflow stages do not retain browser JWTs. Any refreshed execution grant must bind the same operation/principal/frozen revisions/disclosure and valid upstream policy. Keep original snapshot/receipt hashes unchanged. A new grant must not bypass revocation, purge, or ownership cutover.

While upstream policy remains valid, renewal is narrowly scoped to the same operation. Expired or changed policy requires explicit owner reauthorization through the existing namespace/delegation procedure; recovery #207 then reconciles existing checkpoints. Do not silently widen policy scope/TTL, adopt new source heads, or repeat a committed model stage.

Coordinate current-view/loader changes with #197 instead of creating competing SQL views. Use additive migrations and old/new readback tests. Handing a run to another agent requires explicit delegation, not knowledge of its ID.

## 5. Acceptance criteria

- [ ] A run crosses the snapshot/browser-JWT TTL while its operation authorization remains valid, without an open tab or changes to frozen IDs/hashes.
- [ ] Policy/delegation expiry, revocation, purge, cutover, and cancellation prevent subsequent dispatch. Historical results remain readable only where current rights permit.
- [ ] Lawful reauthorization/recovery continues the original run; revoked authority is not inadvertently revived.
- [ ] Time-boundary tests exercise real D1 predicates with controlled fixtures, not only a mocked JavaScript Date.
- [ ] Record exact SHA and positive/negative HTTP/Workflow/D1/R2 tests; a native long-run case belongs to separate final live acceptance.
