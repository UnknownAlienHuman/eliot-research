# S65 — Connect coherent BackupEpoch and an authorized offsite adapter

Baseline: `a2aca127`; ER-34. O2 already implements encryption, nonce authority, coherent cuts, and replay; do not rewrite them. The real external destination and credentials are operator configuration, not values to guess.

## 1. Problem

infra/backup/README.md establishes local O2 fixtures and a controlled destination, not an operating independent offsite backup. Portable export must cover the current Core schema after recent migrations.

## 2. Required change

Connect packages/platform-cloudflare/src/backup.ts to actual D1/R2 source ports and existing copyOffsiteExport. Implement deployment binding for the existing OffsiteCopyAdapter interface (describe/put/get/delete) against an explicitly configured authorized destination. Do not introduce another cloud backend.

## 3. Documentation and exact search anchors

[Backup contour](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/infra/backup/README.md); [ER-34](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-34-backup-restore-and-platform-exit.md).

```sh
git grep -n -F 'O2 (IMPLEMENTED_NOT_LIVE)' -- infra/backup/README.md
git grep -n -F 'export interface OffsiteCopyAdapter' -- packages/backup-o2/src/offsite.ts
```

## 4. Implementation approach

Reuse epoch.ts, coherent-cut.ts, offsite.ts, destination/nonce/replay authority, and additive migrations 0018/0019. Export every current authority table/column and the R2 manifest at a coherent cut; unknown tables cannot be silently skipped. Secrets/KEKs are excluded. Verify bytes by ciphertext readback and authenticated decryption before accepting a receipt; ACK alone is insufficient. Stream bounded parts rather than buffering an entire epoch.

A controlled destination tests the local adapter contract. Live acceptance requires verified failure-domain independence, retention/deletion capabilities, and endpoint/credential references. Missing live configuration does not prevent code/test completion, but cannot be replaced with a fictitious destination or fixture receipt. Another bucket in the same failure domain is not automatically an independent backup.

## 5. Acceptance criteria

- [ ] Populated Core/R2 exports a complete portable epoch containing schema/migrations/purge/heads/objects without omitted new columns or secret leakage.
- [ ] Concurrent writes are handled by the defined coherent-cut boundary or produce explicit incomplete export; corrupt/missing parts fail.
- [ ] Lost put ACK/restart/replay preserve copy identity and durable nonce uniqueness; expiry/deletion readback works and locked destinations remain BLOCKED.
- [ ] Existing O2 tests remain and an actual workerd/D1 source-port regression is added.
- [ ] Record exact SHA/results; native offsite put/get/delete and independent-failure-domain evidence follow separately on an authorized destination.
