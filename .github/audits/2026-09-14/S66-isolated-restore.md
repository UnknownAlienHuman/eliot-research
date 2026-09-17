# S66 — Restore BackupEpoch without resurrecting erased data

Baseline: `a2aca127`; ER-34/13. Inputs: S65/#257 epoch, current purge ledger, and integrated S63/#255 closure. ER-34 leaves O3/O4 incomplete.

## 1. Problem

A backup alone does not restore the system safely. An old epoch may contain subsequently erased documents, revoked grants, and obsolete schemas; it cannot be exposed to serving traffic unchanged.

## 2. Required change

Complete the existing restore port: validate epoch → restore Core into an isolated target → apply current purge/policy → restore permitted objects → verify heads → rebuild projections → only then establish readiness. Do not create a second production backend.

## 3. Documentation and exact search anchors

[ER-34, Mandatory negative boundary](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-34-backup-restore-and-platform-exit.md).

```sh
git grep -n -F 'Restore an epoch containing later-purged bytes' -- docs/agent-work/ER-34-backup-restore-and-platform-exit.md
```

## 4. Implementation approach

Reuse BackupEpoch/manifest parsers, migration history, erasure closure, and projection rebuild S52/#244. Before any write, verify a target distinct from serving resources with traffic disabled. Missing independently current purge state prevents disclosure. Never replace current denials with the epoch's old ledger.

Do not reactivate secrets or revoked credentials from backup; operator credentials are configured separately. Restore checkpoints use existing operation identity and bind each part to epoch/hash. Queue/DO/search are reconstructed from Core/R2 rather than treated as canonical authority. Source handles retain exact identities where valid; purged handles remain nonrevealing/redacted. Portable platform-exit export uses the same epoch format.

## 5. Acceptance criteria

- [ ] Restoring a pre-purge epoch after a purge cannot expose erased bytes, metadata, or active influence through HTTP/indexes. Missing current purge state keeps readiness false.
- [ ] Permitted source/Wiki/Investigation/artifact heads match recorded hashes; grants are reissued only under current policy.
- [ ] Interrupted/corrupt/missing-part restore never enables traffic; replay resumes the same operation and rebuilding does not duplicate canonical state.
- [ ] Run actual local D1/R2 restore regressions with current migrations and measured duration.
- [ ] Record exact SHA/runbook and separate clean-target live RPO/RTO evidence after explicit target authorization.
