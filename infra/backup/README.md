# BackupEpoch and restore contour

ER-34 owns the portable backup/restore implementation. A BackupEpoch includes schema and migration
ledgers, D1 Core JSONL, source/project/scope manifests, EvidenceHandle registry including tombstones,
R2 object manifests, Wiki/artifact/investigation heads, generation records, and the current PurgeLedger.
D1 Search, AI Search, Queue, and live Durable Object state are rebuilt rather than treated as authority.

O2 (IMPLEMENTED_NOT_LIVE) is the portable coherent epoch plus the encrypted independent offsite
copy: `packages/backup-o2/**` with a thin `packages/platform-cloudflare/src/backup.ts` facade and
focused tests in `packages/backup-o2/src/*.test.ts` running against real local SQLite executing the
tracked core migrations plus `0018_backup_o2_replay_authority.sql` (ER-13 integration dependency,
renamed from 0017 in FIX2 because W1 FIX5 reserves the 0017 slot; 0014–0016 never landed on this
lane) with ledger rows recorded exactly like the authoritative runner, and byte-exact R2 exercised
through the production immutable-write/readback paths. Startup fails closed unless migration 0018
is present in the authoritative ledger with its expected schema shape; there is no runtime CREATE
TABLE substitute and no `migration-ledger:ABSENT` tolerance. Replay authority is D1-backed
(`backup_epoch_receipt`) with the canonical full intent digest and atomic CAS: exact replay from a
new process/port returns the persisted draft/attempt/receipt bytes verbatim, and any same-key
divergence in any bound field conflicts with zero new side effects. A controller-owned coherent-cut
token (`backup_export_cut`) binds D1 tables/schema/migration/purge plus the R2 inventory generation
to one cut; the phase-2 seal rejects observable drift, including R2 re-put rollback via fresh
etag/version. Every real Core column is exported and PRAGMA-verified against the complete schema
inventory, and manifests carry the versioned `eliotr.backup-manifest.v1` protocol identifier. The
complete authority vector (schema generation, migration ledger, per-table counts/digests, purge
frontier, R2 pagination fingerprints and watermarks) is persisted as a content-addressed `vector`
manifest; its digest is bound into the epoch, parts and receipts, and reopened independently.
Exhaustive durable-state coverage fails closed on unclassified tables/columns; R2 list/get coherence
compares key/size/etag/mandatory-version/custom-metadata/httpMetadata and never leaks raw object
keys into errors or receipts. Offsite copies require controller-owned D1 destination authority bound
to the initiating principal plus the approved policy decision and authorization receipt (adapter
self-report is evidence only; caller refs never self-authorize; admissibility uses the
controller-disciplined clock) and AES-256-GCM with canonical AAD binding epoch, part, policy, key
generation and expiry plus durably unique nonces (deterministic per key generation/copy/part/content
/policy, checkpointed in D1 with resume); every remote part is read back and authenticated before
the offsite receipt, and the success authority persists for verbatim replay. O2 expiry lifecycle
(D1-authoritative expires_at/draft/holds, durable delete intent/receipt, absence proof re-proven on
terminal replay, resurrection prevention) is implemented; legal hold/retention lock/controller hold
blocks auditably. See `offsite-test-destination.json` for the controlled test destination capability
(no credentials, no live-provider receipt claim).

Restore order is fail-closed: restore Core in isolation, apply PurgeLedger and current policy before any
payload exposure, remove or quarantine purged influence, restore remaining R2 objects, then rebuild
projections and run LIVE/REDACTED handle acceptance cases. No readiness receipt is issued before this
sequence completes. O3 isolated restore and O4 purge replay stay NOT_IMPLEMENTED and fail closed.
