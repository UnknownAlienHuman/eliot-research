# BackupEpoch and restore contour

ER-34 owns the portable backup/restore implementation. A BackupEpoch includes schema and migration
ledgers, D1 Core JSONL, source/project/scope manifests, EvidenceHandle registry including tombstones,
R2 object manifests, Wiki/artifact/investigation heads, generation records, and the current PurgeLedger.
D1 Search, AI Search, Queue, and live Durable Object state are rebuilt rather than treated as authority.

O2 (IMPLEMENTED_NOT_LIVE) is the portable coherent epoch plus the encrypted independent offsite
copy: `packages/backup-o2/**` with a thin `packages/platform-cloudflare/src/backup.ts` facade and
focused tests in `packages/backup-o2/src/*.test.ts` running against real local SQLite executing the
tracked core migrations plus `0017_backup_o2_replay_authority.sql` (ER-13 integration dependency)
and byte-exact R2 exercised through the production immutable-write/readback paths. Replay authority
is D1-backed (`backup_epoch_receipt`) with atomic CAS: exact replay from a new process/port returns
the same immutable receipt; divergent reuse conflicts. The complete authority vector (schema
generation, migration ledger, per-table counts/digests, purge frontier, R2 pagination fingerprints
and watermarks) is persisted as a content-addressed `vector` manifest; its digest is bound into the
epoch, parts and receipts, and reopened independently. Exhaustive durable-state coverage fails closed
on unclassified tables/columns; R2 list/get coherence compares key/size/etag/version/metadata.
Offsite copies require controller-approved destination policy plus authorization receipt (adapter
self-report is evidence only) and AES-256-GCM with canonical AAD binding epoch, part, policy, key
generation and expiry plus nonce-uniqueness enforcement; every remote part is read back and
authenticated before the offsite receipt. O2 expiry lifecycle (durable delete intent/receipt, absence
proof, resurrection prevention) is implemented; legal hold/retention lock blocks auditably. See
`offsite-test-destination.json` for the controlled test destination capability (no credentials, no
live-provider receipt claim).

Restore order is fail-closed: restore Core in isolation, apply PurgeLedger and current policy before any
payload exposure, remove or quarantine purged influence, restore remaining R2 objects, then rebuild
projections and run LIVE/REDACTED handle acceptance cases. No readiness receipt is issued before this
sequence completes. O3 isolated restore and O4 purge replay stay NOT_IMPLEMENTED and fail closed.
