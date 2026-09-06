# BackupEpoch and restore contour

ER-34 owns the portable backup/restore implementation. A BackupEpoch includes schema and migration
ledgers, D1 Core JSONL, source/project/scope manifests, EvidenceHandle registry including tombstones,
R2 object manifests, Wiki/artifact/investigation heads, generation records, and the current PurgeLedger.
D1 Search, AI Search, Queue, and live Durable Object state are rebuilt rather than treated as authority.

O2 (IMPLEMENTED_NOT_LIVE) is the portable coherent epoch plus the encrypted independent offsite
copy: `packages/platform-cloudflare/src/backup-{shared,epoch,offsite}.ts` with focused tests in
`backup.test.ts` running against real local SQLite executing the tracked core migrations and
byte-exact R2 exercised through the production immutable-write/readback paths. The authority vector
(schema generation, migration ledger, per-table counts/digests, purge frontier, R2 fingerprint) is
frozen before external R2/part work and re-read after; any drift withholds the epoch as stale.
Offsite copies are AES-GCM encrypted before the destination boundary with injected keys; every
remote part is read back and authenticated before the offsite receipt. See
`offsite-test-destination.json` for the controlled test destination capability (no credentials).

Restore order is fail-closed: restore Core in isolation, apply PurgeLedger and current policy before any
payload exposure, remove or quarantine purged influence, restore remaining R2 objects, then rebuild
projections and run LIVE/REDACTED handle acceptance cases. No readiness receipt is issued before this
sequence completes. O3 isolated restore and O4 purge replay stay NOT_IMPLEMENTED and fail closed.
