# S67 — Roll back code/index generations without rolling back data authority

Baseline: `a2aca127`; ER-26/24/38. Inputs: #197 compatibility and #244 index generations. Restore #258 is a distinct operation, not a prerequisite for developing rollback.

## 1. Problem

Returning to an old Worker or index head does not authorize rolling back purge/policy/schema or resurrecting revoked data. PWA-only continuity does not establish backend upgrade/rollback compatibility.

## 2. Required change

Implement verified rollback of an exact build/index generation through the existing deployment orchestrator with independent readback. First support a backend build compatible with the current schema and retained handler generations; reject incompatible rollback before switching.

## 3. Documentation and exact search anchors

[Production-readiness plan, section 13](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).

```sh
git grep -n -F 'Test Worker/index rollback independently from data restore.' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Extend existing deployment receipts/version readback and index expected-head switching. Verify target code/schema/config/resource identities, current purge state, and active-run compatibility. Use authorized current configuration/secret references rather than restoring obsolete secrets from backup. Do not rewrite merged migrations, current source/Wiki/artifact heads, or source ownership to satisfy old code.

For incompatible handlers, preserve runs and authorized readable history with a specific reason/forward-repair action; do not create replacement runs. A native platform rollback is a mechanism, not proof of application correctness. Versioned transition tests must establish any compatibility beyond S05's identical-backend case.

## 5. Acceptance criteria

- [ ] Compatible A→B→A retains canonical heads/purge; compatible active runs continue original checkpoints without repeated committed paid effects.
- [ ] Index B→A retains exact resolution/current policy and does not return erased members.
- [ ] Missing build, wrong resource/schema, incompatible handlers, stale CAS, and lost ACK produce safe rejection or reconciled readback rather than false success.
- [ ] Local ordering/dry-run/readback tests pass; separately record an authorized native rollback receipt.
- [ ] The runbook identifies exact builds and result verification, not an undifferentiated revert-everything action; include implementation SHA/results.
